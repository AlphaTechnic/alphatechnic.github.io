---
title: 'The Hidden Trap of Scala lazy val and Kryo Serialization'
description: 'While monitoring our live services, we ran into an exception that should not happen in a statically typed language like Scala: a type conversion error at...'
pubDate: 2026-08-09
tags: ['ClassCastException', 'kryo', 'lazy val', 'scala']
---

## Intro

While monitoring our live services, we ran into an exception that should not happen in a statically typed language like Scala: a type conversion error at runtime, in a codebase guarded by strict compile-time type checks. It started showing up after we upgraded our server from Scala 2 to Scala 3, even though the code involved had not changed.

This post walks through how we solved a bug that was hard to understand from the logs alone: **Formulating a Hypothesis → Understanding What Changed in Scala 3 → Analyzing the Kryo Source Code → Building a Minimal Repro → Choosing a Fix Based on Trade-offs, with Safety Nets**.

## The Problem: A `ClassCastException` in a Statically Typed Language

Our live service logs contained the following exception:

```text
Died during request processing
Cause: java.lang.ClassCastException: class scala.collection.immutable.Map$Map1
cannot be cast to class scala.collection.immutable.List
```

This error was puzzling for four reasons:

1. **Broken Type Safety**: There was no code that cast between `Map` and `List`. A guarantee of the static type system was broken at runtime.
2. **Self-healing**: When the exact same request was retried, it succeeded and returned a **normal response**.
3. **Intermittent Occurrence**: It rarely happened, and mostly under specific conditions such as high traffic.
4. **New After the Upgrade**: We had never seen it while the server ran on Scala 2. It appeared only after the move to Scala 3.

The stack trace only showed the moment a wrong type was used. It did not show where the data had actually been corrupted.

## Clues and Hypothesis: "Why Does It Fail Only on the First Attempt, and Under High Traffic?"

The most important clue was that **it failed only on the first request and recovered on retry**. This suggested a state that _exists only briefly during the first operation and then disappears_, which pointed us to Scala's **`lazy val` initialization**.

The **intermittent** nature of the error supported this hypothesis. The `lazy val` in question was expensive to compute. Normally it finished almost instantly, but when traffic spiked and threads competed for CPU, the computation took longer. We suspected that **the longer the field stayed in its "being evaluated" state, the more likely it was to overlap with serialization**, and the more often the error would occur.

The fact that it only appeared after the upgrade also fit. If the cause was `lazy val` initialization, then the way Scala 3 initializes a `lazy val` had to be different from Scala 2 in some way that mattered here. So we compared the two.

### Scala 2 `lazy val`: A Separate Flag and a Lock

In Scala 2, the compiler keeps the initialization state in a **separate bitmap field** and protects the computation with `synchronized` on the enclosing object. The value field itself stays empty (`null`) until the computation finishes:

```scala
// Scala 2: what `lazy val top = compute()` roughly compiles to (simplified)
private var top: T = _                    // stays null until computed
@volatile private var bitmap$0: Boolean = false

def top: T = if (bitmap$0) top else top$lzycompute()

private def top$lzycompute(): T = this.synchronized {
  if (!bitmap$0) { top = compute(); bitmap$0 = true }
  top
}
```

So no matter when someone looks at the field directly, it holds either `null` or the finished value.

refer: [AccessorSynthesis.scala](https://github.com/scala/scala/blob/2.13.x/src/compiler/scala/tools/nsc/transform/AccessorSynthesis.scala) (bitmap and `synchronized` slow path), [Fields.scala](https://github.com/scala/scala/blob/2.13.x/src/compiler/scala/tools/nsc/transform/Fields.scala)

### Scala 3 `lazy val`: The State Lives in the Value Field

Since Scala 3.3, the compiler drops the lock and the separate bitmap. It stores the state **in the value field itself**, in a hidden field such as `top$lzy1`, and moves between states with CAS:

- `null` means nobody has started computing it yet. The first thread to access it computes the value.
- A **sentinel object** (`Evaluating`, or `Waiting` if other threads are waiting) means another thread is computing it right now. Accessing threads wait for that thread to finish.
- Anything else is the computed value. (If the result itself is `null`, a `NullValue` sentinel is stored instead.)

```scala
// Scala 3.3+: the same lazy val (simplified)
@volatile private var top$lzy1: AnyRef = null
// null       -> not started
// Evaluating -> a thread is computing it
// Waiting    -> a thread is computing it and others are waiting
// NullValue  -> computed, and the result was null
// otherwise  -> the computed value
```

refer: [LazyVals.scala (compiler)](https://github.com/scala/scala3/blob/main/compiler/src/dotty/tools/dotc/transform/LazyVals.scala) (CAS-based initialization), [LazyVals.scala (runtime)](https://github.com/scala/scala3/blob/main/library/src/scala/runtime/LazyVals.scala) (`Evaluating`, `Waiting`, `NullValue`)

|     | Scala 2 | Scala 3.3+ |
| --- | --- | --- |
| Where the state lives | Separate bitmap field | The value field itself |
| Concurrency control | `synchronized` on the enclosing object | CAS on the field |
| Value field while computing | `null` | Sentinel object (`Evaluating` / `Waiting`) |
| What a reflection-based serializer sees | `null` or the real value | `null`, a sentinel, or the real value |

Scala 3 made this change to avoid locking the whole object, which could cause deadlocks and contention. But it also means that, for a short moment, the value field holds an object that is **not a value of the declared type**. Anyone who reads the field without going through the `lazy val` accessor can see it.

Kryo is exactly that kind of reader. From this, we formed the following hypothesis:

> **Hypothesis:** While serializing the object graph, a `lazy val` sentinel captured mid-evaluation gets tangled up with our custom Kryo serializer and Kryo's reference tracking, corrupting Kryo's internal reference table.

## Deep Dive into the Cause: Unpacking Kryo's `MapReferenceResolver` Source Code

To verify this hypothesis, we dug into Kryo's reference tracking mechanism and its source code.

Unless configured otherwise, Kryo uses `MapReferenceResolver`. Despite its name, it only uses a map when writing (object → ID). When reading, it stores objects in an `ArrayList` and uses the ID as the index.

```java
// MapReferenceResolver (Kryo 4.0.2 and 5.x)
public int nextReadId (Class type) {
    int id = readObjects.size();
    readObjects.add(null);          // the slot is reserved as soon as an ID is issued
    return id;
}

public void setReadObject (int id, Object object) {
    readObjects.set(id, object);
}

// Kryo.reference(): called after an object is read
public void reference (Object object) {
    ...
    } else if (references && object != null) {   // <- does nothing for null
        int id = readReferenceIds.pop();
        if (id != NO_REF) referenceResolver.setReadObject(id, object);
    }
}

// Kryo.readClassAndObject(): fallback registration
object = registration.getSerializer().read(this, input, type);
if (stackSize == readReferenceIds.size) reference(object);
```

refer: [MapReferenceResolver.java](https://github.com/EsotericSoftware/kryo/blob/master/src/com/esotericsoftware/kryo/util/MapReferenceResolver.java), [Kryo.java](https://github.com/EsotericSoftware/kryo/blob/master/src/com/esotericsoftware/kryo/Kryo.java)

During deserialization, Kryo issues reference IDs (0, 1, 2...) in the same order as the writer did, and uses them as indexes into the `ArrayList`. Reading an object takes two steps:

1. When Kryo sees a new object, it reserves a slot and pushes the ID onto a pending stack (`readReferenceIds`).
2. When the object is fully built, `reference(object)` pops that ID and stores the object in the slot.

If a serializer doesn't register the object itself, Kryo calls `reference()` afterwards as a fallback. It does this only when the pending stack is back to the size it had when this object started.

### What Got Tangled Up? (An Unreturned Reference Ticket)

Our custom Kryo serializer wrote the `lazy val` sentinel as `null`. However, before the serializer even ran, Kryo's `ReferenceResolver` **treated the sentinel itself as a reference target and assigned it an ID**.

When the same sentinel appears **twice** in one object graph, the following asymmetry occurs:

```text
[Serialization (Write) Phase]
1. While serializing object P, Kryo finds a lazy val field holding the Evaluating sentinel.
   -> The ReferenceResolver assigns the sentinel Reference ID 7 and writes "new object".
2. Our custom serializer writes the sentinel's content as null.
3. Later, another lazy val field also holds Evaluating. It is a singleton, so it is the same object.
   -> Kryo writes only a back-reference: "same as ID 7".

[Deserialization (Read) Phase]
1. Kryo reads "new object", reserves slot 7, and pushes ID 7 onto the pending stack.
2. The custom serializer returns null. reference(null) does nothing, so ID 7 is never popped.
   A stale ticket is left on the stack.
3. P finishes. P already registered itself at the start of its read. But because of the stale
   ticket, the pending stack looks unchanged, so Kryo's fallback calls reference(P) again.
   This pops ID 7 and stores P in slot 7.
4. Kryo reads "same as ID 7" and puts P, not null, into the second lazy val field.
5. Accessing that lazy val casts P to the field's type and throws a ClassCastException.
```

Writing `null` was semantically right: on the reader's side, a `null` field means "not computed yet", so the `lazy val` is simply recomputed. The bug was in Kryo's bookkeeping. A `null` result never returns its reference ticket, so the enclosing object takes over that ID, and any later back-reference to the same sentinel receives that unrelated object.

How can the same sentinel appear twice? One way is a `lazy val` that calls another `lazy val` while computing. In one of our production cases, `topVisitors: List` was being computed and called `stats.valuesList`, another `lazy val` inside a `KeyedContainer`. At that moment both fields held `Evaluating`, so the `KeyedContainer` ended up in the `List` field. The types in the error message depend on where the sentinels sit in the graph.

This bug also depended on a **race condition between threads**. In the brief moment when one thread had marked the `lazy val` as `Evaluating` (Scala 3 uses a CAS on the field, not a lock) and was computing it, another thread serialized the same object. Kryo reads fields directly via reflection and bypasses the `lazy val` accessor, so it captured the raw sentinel instead of waiting for the value.

This also explains why we had never seen the bug on Scala 2. The same race existed there, but a Scala 2 `lazy val` field that is still being computed is just `null`, with the flag kept in a separate field. Kryo would have serialized a plain `null` and a `false` flag, and the reader would simply recompute the value. There was no sentinel to number, so there was no ticket to leave behind.

## Building the Repro Environment

The bug depended on timing, so we wrote a minimal test that reproduces it deterministically. Instead of racing threads, it uses reflection to put two nested `lazy val`s into the "being evaluated" state, and then runs them through the same kind of serializer we had in production.

```scala
// The custom serializer we had in production: write the sentinel as null
class SentinelToNull extends Serializer[AnyRef] {
  override def write(k: Kryo, out: Output, obj: AnyRef): Unit = k.writeClassAndObject(out, null)
  override def read(k: Kryo, in: Input, t: Class[AnyRef]): AnyRef = k.readClassAndObject(in)
}

class Inner(val m: Map[String, Int]) {
  lazy val values: List[Int] = m.values.toList
}
class Outer(val inner: Inner) {
  lazy val top: List[Int] = inner.values.sorted // a lazy val that calls another lazy val
}

// Put a lazy val into the "being evaluated" state without threads
def markEvaluating(obj: AnyRef, name: String): Unit = {
  val f = obj.getClass.getDeclaredFields.find(_.getName.startsWith(name + "$lzy")).get
  f.setAccessible(true)
  f.set(obj, LazyVals.Evaluating)
}

// newKryo / roundTrip: plain Kryo setup and a serialize → deserialize helper (omitted)
test("A stale reference ticket puts the wrong object into a lazy val") {
  val kryo = newKryo(references = true)
  kryo.register(LazyVals.Evaluating.getClass, new SentinelToNull)

  val outer = new Outer(new Inner(Map("a" -> 1)))
  markEvaluating(outer, "top")          // top is being computed...
  markEvaluating(outer.inner, "values") // ...and it has just called inner.values

  val restored = roundTrip(kryo, outer)
  assertThrows[ClassCastException](restored.top) // Inner cannot be cast to List
}
```

Running variations of this test against `kryo-shaded 4.0.2`, the version our service used, gave the following results:

| Case | Result |
| --- | --- |
| Two sentinels, reference tracking on | `ClassCastException`: `Inner` cannot be cast to `List` |
| One sentinel, reference tracking on | OK: the stale ID is never referenced again |
| Two sentinels, reference tracking off (Option B below) | OK: `top` is recomputed |
| Two sentinels, sentinel types excluded from tracking (Option A below) | OK  |

By tracing the byte stream against Kryo's source code, we confirmed that a `null` result leaves its reference ID on the pending stack, and the enclosing object then claims that ID.

## Resolution and Decision Making: Trade-offs and Safety Nets

With the cause clear, we weighed two possible solutions.

- **Option A. Modify the Custom Serializer Setup** (exclude sentinel types from reference tracking)
    - **Pros:** Fixes this case (confirmed in the repro) and keeps the payload size unchanged
    - **Cons: The same bug can come back** with any other serializer that returns `null` for an object Kryo has already numbered
- **Option B. Disable Reference Tracking Entirely** (`kryo.setReferences(false)`)
    - **Pros: Removes the whole class of bugs**, because there is no reference table left to corrupt
    - **Cons: Risk of infinite recursion (`StackOverflowError`)** if the graph contains circular references, and shared objects are written more than once

Our codebase had already accumulated temporary workarounds similar to Option A, each excluding a specific internal type. We didn't want to keep adding another exclusion, after another live error, every time an unexpected type like this `lazy val` sentinel showed up. The Scala 3 sentinels themselves were a reminder of how such types appear: a compiler or library upgrade can change what sits inside our objects without any change to our own code.

So we decided that if we could control Option B's main risk (circular references), removing the root cause would be far better for long-term stability. We put the following safety nets in place and then **adopted Option B (`setReferences(false)`)**.

### \[Safety Net 1\] Validating Domain Models

We audited the domain objects and DTO graphs across the project to make sure they contained no circular references that could cause infinite recursion.

### \[Safety Net 2\] Max Depth Monitoring

Even so, we prepared for an unexpected circular reference appearing in production. A max depth doesn't make circular references serializable. Instead, it makes serialization fail fast with a clear `KryoException: Max depth exceeded` rather than a `StackOverflowError`, so we can detect and track the problem immediately.

```scala
// Kryo setup and safety net for detecting circular references
val kryo = new Kryo()

kryo.setReferences(false) // Remove the reference table, and with it the corruption

// Fail fast with a clear error if a circular reference or abnormally deep nesting occurs
kryo.setMaxDepth(100)
```

### Result

After deploying to production, the intermittent `ClassCastException` disappeared completely. The max depth error never fired once in production, which supported our conclusion that our domain had no circular references.

## Conclusion

Here is what we learned from tracking down this mysterious `ClassCastException` in production:

- **Focusing on the Anomalies:** The clues "it fails only on the first attempt" and "it happens intermittently under high traffic" together pointed to the evaluation state of an expensive `lazy val`.
- **Asking What Changed:** "It never happened on Scala 2" was a clue too. Comparing how Scala 2 and Scala 3 compile a `lazy val` showed that Scala 3 puts a sentinel in the value field itself, and that is what made the rest of the bug understandable.
- **Looking Underneath the Abstraction:** By reading Kryo's source code, we found that a `null` result never returns its reference ticket, which lets another object claim that ID.
- **Designing Trade-offs and Monitoring:** Instead of avoiding the feature's downside (circular references) blindly, we combined domain validation with a max depth limit. This let us remove the root cause while still being able to detect the risk we accepted.

A reflection-based serializer like Kryo sees our objects exactly as the compiler laid them out, not as our source code describes them. So when the language or a library is upgraded, those internal layouts can change underneath us. The lesson we took away is that a compiler or serializer upgrade deserves to be tested against real serialized data, not treated as just a version bump.
