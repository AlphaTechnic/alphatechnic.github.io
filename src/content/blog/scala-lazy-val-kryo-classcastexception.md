---
title: 'The Hidden Trap of Scala lazy val and Kryo Serialization'
description: 'A ClassCastException appeared after we moved to Scala 3. Kryo was serializing a lazy val that was still being computed.'
pubDate: 2026-08-09
tags: ['ClassCastException', 'kryo', 'lazy val', 'scala']
---

## Intro

While we were monitoring our live services, we found an exception that should not happen in a statically typed language like Scala. It was a type conversion error at runtime, in a codebase protected by strict compile-time type checks. It started to appear after we upgraded our server from Scala 2 to Scala 3. The code involved had not changed.

This post explains how we solved a bug that was hard to understand from the logs alone. These were the steps: **Forming a Hypothesis → Understanding What Changed in Scala 3 → Analyzing the Kryo Source Code → Building a Minimal Repro → Choosing a Fix Based on Trade-offs, with Safety Nets**.

## The Problem: A `ClassCastException` in a Statically Typed Language

Our live service logs contained the following exception:

```text
Died during request processing
Cause: java.lang.ClassCastException: class scala.collection.immutable.Map$Map1
cannot be cast to class scala.collection.immutable.List
```

This error was confusing for four reasons:

1. **Broken Type Safety**: There was no code that cast between `Map` and `List`. A guarantee of the static type system was broken at runtime.
2. **Self-healing**: When the exact same request was retried, it succeeded and returned a **normal response**.
3. **Intermittent Occurrence**: It rarely happened. When it did, it was mostly under specific conditions such as high traffic.
4. **New After the Upgrade**: We had never seen it while the server ran on Scala 2. It appeared only after the move to Scala 3.

The stack trace only showed the moment a wrong type was used. It did not show where the data had actually been corrupted.

## Clues and Hypothesis: "Why Does It Fail Only on the First Attempt, and Under High Traffic?"

The most important clue was that **it failed only on the first request and recovered on retry**. This suggested a state that _exists only briefly during the first operation and then disappears_. That pointed us to Scala's **`lazy val` initialization**.

The **intermittent** nature of the error supported this hypothesis. The `lazy val` in question was expensive to compute. Normally it finished almost instantly. But when traffic spiked and threads competed for CPU, the computation took longer. We suspected that **the longer the field stayed in its "being evaluated" state, the more likely it was to overlap with serialization**. We also suspected that the error would occur more often as that time grew.

The error only appeared after the upgrade, and this fact also fit. Suppose the cause was `lazy val` initialization. Then Scala 3 had to initialize a `lazy val` differently from Scala 2, in some way that mattered here. So we compared the two.

### Scala 2 `lazy val`: A Separate Flag and a Lock

In Scala 2, the compiler keeps the initialization state in a **separate bitmap field**. It protects the computation with `synchronized` on the enclosing object. The value field itself stays empty (`null`) until the computation finishes:

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

So whenever someone looks at the field directly, it holds either `null` or the finished value.

refer: [AccessorSynthesis.scala](https://github.com/scala/scala/blob/2.13.x/src/compiler/scala/tools/nsc/transform/AccessorSynthesis.scala) (bitmap and `synchronized` slow path), [Fields.scala](https://github.com/scala/scala/blob/2.13.x/src/compiler/scala/tools/nsc/transform/Fields.scala)

### Scala 3 `lazy val`: The State Lives in the Value Field

Since Scala 3.3, the compiler no longer uses the lock and the separate bitmap. It stores the state **in the value field itself**, in a hidden field such as `top$lzy1`. It moves between states with CAS:

- `null` means nobody has started computing it yet. The first thread to access it computes the value.
- A **sentinel object** means another thread is computing it right now. This object is `Evaluating`, or `Waiting` if other threads are waiting. Threads that access it wait for that thread to finish.
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

Scala 3 made this change to avoid locking the whole object, which could cause deadlocks and contention. But the change also has another effect. For a short moment, the value field holds an object that is **not a value of the declared type**. Anyone who reads the field without going through the `lazy val` accessor can see it.

Kryo is exactly that kind of reader. From this, we formed the following hypothesis:

> **Hypothesis:** While the object graph is being serialized, a `lazy val` sentinel is captured in the middle of evaluation. The sentinel gets mixed up with our custom Kryo serializer and Kryo's reference tracking. This corrupts Kryo's internal reference table.

## Deep Dive into the Cause: Unpacking Kryo's `MapReferenceResolver` Source Code

To verify this hypothesis, we studied Kryo's reference tracking mechanism and its source code.

Kryo uses `MapReferenceResolver` unless it is configured otherwise. Despite its name, it only uses a map when writing (object → ID). When reading, it stores objects in an `ArrayList` and uses the ID as the index.

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

During deserialization, Kryo issues reference IDs (0, 1, 2...) in the same order as the writer did. It uses them as indexes into the `ArrayList`. Reading an object takes two steps:

1. When Kryo sees a new object, it reserves a slot and pushes the ID onto a pending stack (`readReferenceIds`).
2. When the object is fully built, `reference(object)` pops that ID and stores the object in the slot.

If a serializer doesn't register the object itself, Kryo calls `reference()` afterwards as a fallback. It does this only when the pending stack is back to the size it had when this object started.

### What Got Tangled Up? (An Unreturned Reference Ticket)

Our custom Kryo serializer wrote the `lazy val` sentinel as `null`. However, Kryo's `ReferenceResolver` acted before the serializer even ran. It **treated the sentinel itself as a reference target and assigned it an ID**.

When the same sentinel appears **twice** in one object graph, the following mismatch occurs:

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

Writing `null` was semantically right, because a `null` field means "not computed yet" on the reader's side. The `lazy val` is then simply recomputed. The bug was in how Kryo keeps track of references. A `null` result never returns its reference ticket, so the enclosing object takes over that ID. Any later back-reference to the same sentinel then receives that unrelated object.

How can the same sentinel appear twice? One way is a `lazy val` that calls another `lazy val` while computing. In one of our production cases, `topVisitors: List` was being computed. It called `stats.valuesList`, another `lazy val` inside a `KeyedContainer`. At that moment both fields held `Evaluating`, so the `KeyedContainer` ended up in the `List` field. The types in the error message depend on where the sentinels are in the graph.

This bug also depended on a **race condition between threads**. One thread had marked the `lazy val` as `Evaluating` and was computing it. (Scala 3 uses a CAS on the field, not a lock.) In that short moment, another thread serialized the same object. Kryo reads fields directly via reflection and bypasses the `lazy val` accessor. So it captured the raw sentinel instead of waiting for the value.

This also explains why we had never seen the bug on Scala 2. The same race existed there. But a Scala 2 `lazy val` field that is still being computed is just `null`, and the flag is kept in a separate field. Kryo would have serialized a plain `null` and a `false` flag. The reader would then simply recompute the value. There was no sentinel to number, so there was no ticket to leave behind.

## Building the Repro Environment

The bug depended on timing, so we wrote a minimal test that reproduces it deterministically. The test does not race threads. Instead, it uses reflection to put two nested `lazy val`s into the "being evaluated" state. Then it runs them through the same kind of serializer we had in production.

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

We ran variations of this test against `kryo-shaded 4.0.2`, the version our service used. They gave the following results:

| Case | Result |
| --- | --- |
| Two sentinels, reference tracking on | `ClassCastException`: `Inner` cannot be cast to `List` |
| One sentinel, reference tracking on | OK: the stale ID is never referenced again |
| Two sentinels, reference tracking off (Option B below) | OK: `top` is recomputed |
| Two sentinels, sentinel types excluded from tracking (Option A below) | OK  |

We traced the byte stream against Kryo's source code. This confirmed that a `null` result leaves its reference ID on the pending stack. It also confirmed that the enclosing object then takes that ID.

## Resolution and Decision Making: Trade-offs and Safety Nets

Once the cause was clear, we compared two possible solutions.

- **Option A. Modify the Custom Serializer Setup** (exclude sentinel types from reference tracking)
    - **Pros:** Fixes this case (confirmed in the repro) and keeps the payload size unchanged
    - **Cons: The same bug can come back** with any other serializer that returns `null` for an object Kryo has already numbered
- **Option B. Disable Reference Tracking Entirely** (`kryo.setReferences(false)`)
    - **Pros: Removes the whole class of bugs**, because there is no reference table left to corrupt
    - **Cons: Risk of infinite recursion (`StackOverflowError`)** if the graph contains circular references. Also, shared objects are written more than once

Our codebase had already built up temporary workarounds similar to Option A. Each one excluded a specific internal type. We didn't want to keep adding another exclusion every time an unexpected type like this `lazy val` sentinel showed up. Each of those additions would also come only after another live error. The Scala 3 sentinels themselves reminded us how such types appear. A compiler or library upgrade can change what is inside our objects without any change to our own code.

We decided that removing the root cause would be far better for long-term stability, if we could control Option B's main risk (circular references). We put the following safety nets in place and then **adopted Option B (`setReferences(false)`)**.

### Safety Net 1: Validating Domain Models

We checked the domain objects and DTO graphs across the project. Our goal was to make sure they contained no circular references that could cause infinite recursion.

### Safety Net 2: Max Depth Monitoring

Even so, we prepared for the case where an unexpected circular reference appears in production. A max depth doesn't make circular references serializable. Instead, it makes serialization fail fast. We get a clear `KryoException: Max depth exceeded` rather than a `StackOverflowError`, so we can detect and track the problem immediately.

```scala
// Kryo setup and safety net for detecting circular references
val kryo = new Kryo()

kryo.setReferences(false) // Remove the reference table, and with it the corruption

// Fail fast with a clear error if a circular reference or abnormally deep nesting occurs
kryo.setMaxDepth(100)
```

### Result

After we deployed to production, the intermittent `ClassCastException` disappeared completely. The max depth error never occurred in production, not even once. This supported our conclusion that our domain had no circular references.

## Conclusion

Here is what we learned from tracking down this mysterious `ClassCastException` in production:

- **Focusing on the Anomalies:** We had two clues: "it fails only on the first attempt" and "it happens intermittently under high traffic". Together, they pointed to the evaluation state of an expensive `lazy val`.
- **Asking What Changed:** "It never happened on Scala 2" was a clue too. We compared how Scala 2 and Scala 3 compile a `lazy val`. This showed that Scala 3 puts a sentinel in the value field itself. That is what made the rest of the bug understandable.
- **Looking Underneath the Abstraction:** We read Kryo's source code and found that a `null` result never returns its reference ticket. This lets another object claim that ID.
- **Designing Trade-offs and Monitoring:** We did not blindly avoid the feature's downside (circular references). Instead, we combined domain validation with a max depth limit. This let us remove the root cause and still detect the risk we accepted.

A reflection-based serializer like Kryo sees our objects exactly as the compiler laid them out. It does not see them as our source code describes them. So when the language or a library is upgraded, those internal layouts can change without us noticing. We learned that a compiler or serializer upgrade should be tested against real serialized data. It should not be treated as just a version bump.
