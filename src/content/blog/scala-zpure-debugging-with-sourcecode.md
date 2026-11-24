---
title: 'Solving the Ambiguous Error Problem in Trampolined Effects using Compile-Time Macros'
description: 'Scala''s implicit keyword is incredibly powerful, often praised for enabling elegant DSLs, type class patterns, and dependency injection. However, for those...'
pubDate: 2025-06-22
tags: ['Implicit', 'scala', 'sourcecode']
---

## Intro

Scala's **`implicit`** keyword is incredibly powerful, often praised for enabling elegant DSLs, type class patterns, and dependency injection. However, for those new to Scala or even seasoned developers, its true utility beyond these common use cases might not always be immediately apparent.

I want to share a practical scenario where `implicit`s, combined with the **`sourcecode`** library, dramatically improved our team's development productivity by making our error messages infinitely more useful.

## My Challenge: The Elusive Origin of Errors

In our project, we frequently use common utility functions across the codebase. While convenient, these functions often produced ambiguous error messages that made debugging a real headache.

Take these two examples:

```scala
private def assertCandidatesNonEmpty[T](
    candidates: List[T],
    context: String
  ): ZPure[Nothing, State, State, Any, ValidationError, Unit] =
    assertThat(
      candidates.nonEmpty,
      ValidationError.InvalidInput(s"Invalid input. maximum must be greater than 0. [context: $context]")
    )

def chooseOne[T](
  candidates: List[T],
  context: String = ""
): ZPure[Nothing, State, State, Any, ValidationError, T] =
  for {
    () <- assertCandidatesNonEmpty(candidates, context)
    n  <- getRandInt(candidates.size)
  } yield candidates(n)
```

And another:

```scala
def extractOption[T](
  option: Option[T],
  context: String = "Can't extract option from None."
): Result[T] =
  option match {
    case Some(t) => t.succeed
    case None    => ExtractionError.Generic(s"$context")
  }
```

When an error occurred in `assertCandidatesNonEmpty`, we'd see "`Invalid input. maximum must be greater than 0. [context: ]`". For `extractOption`, it was "`Can't extract option from None.`". The `context` parameter was often either defaulted or simply neglected by developers working under tight deadlines. This meant when an error popped up, we'd spend precious time asking: **"Where did this error even originate?"**

Sure, we could have forced `context` to be mandatory, but manually updating hundreds of existing call sites and then enforcing strict `context` input during rapid development felt like an uphill battle. Then one question arises: **why doesn't the JVM call stack show the caller's information from the immediate previous layer?**

## ZPure Trampoline

#### How Does ZPure Implement Its Trampoline?

Functional effect systems like **ZIO** and **ZPure** use a technique called a **trampoline** as a core mechanism to ensure **stack safety**. Instead of making deep, recursive calls that grow the JVM call stack, a trampoline evaluates each step of a computation within a loop, keeping the physical call stack flat.

- **Normal recursive function**

```scala

f(3)
 └ f(2)
    └ f(1)
       └ f(0)
```

⇒ The structure causes the stack to grow progressively deeper.

- **Trampoline**

```scala
main
 └ run
     while (...) {
       current = nextStep()
     }
```

⇒ It always “jumps” to the next computation from the same location (i.e., the same stack frame). I’d like to cover this topic in a separate post later.

#### Internal Loop Pseudo-code

This execution process is implemented with a `while` loop that looks something like this. The function `f` passed to `flatMap` or `map` is pushed onto a stack data structure. When a `Succeed` is encountered, a function is popped from the stack and applied to the value.

```scala
// Simplified Pseudo-code of the ZPure Runner
def loop(state: Any, zPure: Erased): Either[E, (S, A)] = {
  var s0: Any = state      // Current internal state (S1, S2)
  var a: Any  = null       // The result of the last successful operation
  var curZPure = zPure     // The instruction currently being executed
  val stack = new Stack()  // Heap-based stack for Continuations (flatMap/fold)

  while (curZPure != null) {
    curZPure match {
      // 1. Nesting: Push the "next step" to the stack and dive deeper
      case FlatMap(nested, continuation) =>
        stack.push(continuation)
        curZPure = nested

      // 2. Success: Get the value, pop the next step, and "bounce" back
      case Succeed(value) =>
        a = value
        val nextInstr = stack.pop()
        if (nextInstr == null) curZPure = null // We are done!
        else curZPure = nextInstr(a)           // Continue with the result

      // 3. State Management: Update the state and continue
      case Update(run) =>
        s0 = run(s0)
        val nextInstr = stack.pop()
        curZPure = if (nextInstr == null) null else nextInstr(())

      // 4. Error Handling: Search the stack for a 'Fold' (Error Handler)
      case Fail(error) =>
        curZPure = null 
        while (curZPure == null) {
          stack.pop() match {
            case null => return Left(error)    // No handler found, crash safely
            case f: Fold => curZPure = f.failure(error) // Found a handler!
            case _ => // Skip regular flatMaps while failing
          }
        }
    }
  }
  Right((s0, a))
}
```

### Why Debugging is Difficult

The key takeaway here is that **the JVM's call stack is separate from ZPure's logical evaluation plan stack.** The `caller` functions you write inside `map` and `flatMap` are just "data" stored in ZPure's internal execution “heap” stack (the `stack` variable). They are not functions that get pushed onto the JVM's physical call stack. The JVM call stack only contains a reference to the `run` method that initiated the `while` loop.

As a result, even when an error occurs in the `Fail` case, you cannot trace the logical `caller` (e.g., `map(_ * 2)`) that led to the failure by only looking at the JVM debugger's call stack. This leads to a natural question: "If an error occurs, why can't ZPure just show the contents of its internal evaluation plan stack?" There are a few technical limitations that make this difficult.

### Then Why Doesn't ZPure Show Its Internal Stack?

- **Functions are Anonymous Objects on the JVM.**
    - The functions `f: A => ZPure[B]` stored on the stack are mostly anonymous classes or lambdas generated by the Scala compiler. Calling `toString()` on these function objects yields unreadable strings like `com.example.MyClass$$anonfun$1@3ace9f98`, which are useless for a human.
- **Function Objects Don't Contain Source Code Location Information.**
    - By default, a Scala function object does not contain information about where it was defined in the source code (e.g., file and line number). Therefore, even if you could print the functions from the stack, it would be nearly impossible for a developer to know which part of the code they correspond to.
- **ZPure Does Not Expose a Debugging API.**
    - While `ZPure` internally maintains a stack for continuations (`Stack[Continuation]`), it does not expose this information externally through a debugging API for logging or tracing. (In contrast, `ZIO` provides the `ZTrace` object, which tracks this evaluation plan to aid in debugging.)
- For these reasons, it's difficult for **ZPure** to present a clear, logical call stack upon failure. I needed a programmatic way to inject the necessary debugging information about caller.

## The `implicit` Solution: Automatically Injecting Caller Context with `sourcecode`

My solution came from Scala's `implicit` parameters and the **`sourcecode`** library ([https://github.com/com-lihaoyi/sourcecode](https://github.com/com-lihaoyi/sourcecode)). `sourcecode` injects source code information (like file name, line number, and enclosing function name) at **compile time using macros**. This is crucial because, as its documentation states:

> sourcecode does not rely on runtime reflection or stack inspection, and is done at compile-time using macros. This means that it is both orders of magnitude faster than e.g. getting file-name and line-numbers using stack inspection, and also works on Scala.js where reflection and stack inspection can't1 be used.

This makes it fast and compatible with environments like `Scala.js` where runtime reflection isn't an option. The magic happens when `sourcecode`'s types, like `sourcecode.FullName` and `sourcecode.Line`, are included as `implicit` parameters in a function signature. If no explicit value is provided for these `implicit`s in the calling scope, the compiler **automatically provides them** based on the current call site's information.

Here's how our code changed and the impact it had on error messages

### After Code Changes

- **for `chooseOne`**

```scala
private def assertCandidatesNonEmpty[T](
    candidates: List[T],
    context: String
  )(implicit funcName: sourcecode.FullName, codeLine: sourcecode.Line): ZPure[Nothing, State, State, Any, ValidationError, Unit] =
    assertThat(
      candidates.nonEmpty,
      ValidationError.InvalidInput(s"Called from [${funcName.value}:${codeLine.value}]. Candidates are empty. $context")
    )

def chooseOne[T](
  candidates: List[T],
  context: String = ""
)(implicit funcName: sourcecode.FullName, codeLine: sourcecode.Line): ZPure[Nothing, State, State, Any, ValidationError, T] =
  for {
    () <- assertCandidatesNonEmpty(candidates, context)
    n  <- getRandInt(candidates.size)
} yield candidates(n)
```

- **And for `extractOption`**

```scala
def extractOption[T](
  option: Option[T],
  context: String = "Can't extract option from None."
)(implicit funcName: sourcecode.FullName, codeLine: sourcecode.Line): Result[T] =
  option match {
    case Some(t) => t.succeed
    case None    => ExtractionError.Generic(s"Called from [${funcName.value}:${codeLine.value}]. $context")
  }
```

The true power of this approach lies in how `implicit` parameters propagate down the call chain. When we add `implicit funcName: sourcecode.FullName` and `implicit codeLine: sourcecode.Line` to our functions, here's what happens

When `chooseOne` is called, the compiler fills its `implicit` parameters with the caller's (`Program.scala:157`) function name and line number. Critically, when `chooseOne` then calls `assertCandidatesNonEmpty` (which also expects these `implicit`s), Scala's `implicit` resolution rules ensure that the `funcName` and `codeLine` values already in scope (from `chooseOne`'s caller) are **automatically passed along**.

This means that even if an error is thrown deep within `assertCandidatesNonEmpty`, the error message will contain the context of the **original call site** (`Program.scala:157`), not just the immediate caller of `assertCandidatesNonEmpty`. This allows us to provide precise, user-friendly debugging information exactly where it's needed.

### Error Message Comparison

|     | **Before Change** | **After Change** |
| --- | --- | --- |
| `chooseOne` | "Invalid input. maximum must be greater than 0. \[context: \]" | "Invalid input. Called from **\[program.GachaPrograms:157\]**. Candidates are empty." |
| `extractOption` | "Can't extract option from None." | "Called from **\[extractors.GachaExtractor.extractGachaPools:207\]**. Can't extract option from None." |

The difference is stark. Now, an error message like "`Invalid input. Called from [program.GachaPrograms:157]...`" immediately tells us not just _what_ went wrong, but **exactly _where_ the problematic function was called**. We can simply copy this location into our IDE and jump straight to the source of the issue.

## Measuring Scala Compile Times Correctly

We need to check whether this change comes at the cost of compile time. The goal is to measure the **'stable' time** it takes for source code to compile by eliminating two variables:

- **errors from JVM Warm-up**
- **interference from the external environment (e.g IDE)**

### 1\. Why must it be run within a single `sbt` session? (JVM & JIT Compiler Warm-up)

- **JVM Cold Start:** Both `sbt` and the Scala compiler (`scalac`) run on the Java Virtual Machine (JVM). When you first run `sbt`, the JVM starts, loads numerous classes, and spends a significant amount of time on initialization.
- **JIT (Just-In-Time) Compiler:** Initially, the JVM interprets the code. When it identifies frequently used code (**"Hotspots"**), it compiles that code into native machine code in real-time to optimize performance. This JIT compilation process requires a **"warm-up"** period to stabilize.
- ⇒ The first compilation is measured as being very slow because it includes the JVM startup time, JIT compilation optimization time, and the actual code compilation time. By repeatedly running compilations within the same `sbt` session, the JVM and JIT compiler are already warmed up, allowing you to measure the pure compilation time without this overhead.

### 2\. Why repeat `clean` and `compile` multiple times? (Convergence of Measured Values)

- **The Role of `clean`:** The `clean` command deletes all previous compilation artifacts (like compiled `.class` files). This ensures that the entire codebase is always recompiled from scratch. Without `clean`, Scala's incremental compilation feature would only compile the changed parts, leading to a significantly shorter and inaccurate measurement.
- **The Role of Repetition:** As explained above, it usually takes two to three or more runs for the JIT compiler to fully warm up and deliver stable performance. The compilation time will gradually decrease over the first few runs and then **"converge"** to an almost constant time.
- ⇒ When the measured time no longer decreases after 4-5 repetitions and has stabilized, that value can be reliably considered the stable, full compilation time for that module.

### 3\. Why should you close IDEs like IntelliJ? (Excluding External Interference)

- **Background Compilation:** To display errors in real-time as you write code, IntelliJ continuously runs its own internal compiler in the background. This process consumes CPU and memory resources.
- **Resource Contention:** When you run `sbt compile` in the terminal, it will compete for resources (CPU, disk I/O) with the IDE's background tasks if IntelliJ is running.
- ⇒ This external interference adds **"noise"** to the compilation time measurement, reducing its reliability. Accurate measurement requires a controlled environment with minimal influence from other processes, and closing the IDE is the most effective way to achieve this.

### Practical Measurement Example

You can measure as shown below.

1. Open a terminal in the project's root directory.
2. Run `sbt` to start an `sbt` session.
3. When the `sbt` prompt (`>`) appears, repeat the command below 4-5 times and check the `Total time`.

```bash
// Run inside the sbt shell
// Change 'yourModule' to the actual name of the module you want to measure.
// For example, for the 'core' module, use `core/clean; core/compile`

> yourModule/clean; yourModule/compile
[info] Total time: 25 s, ...  // First run (slowest)

> yourModule/clean; yourModule/compile
[info] Total time: 18 s, ...  // Second run (faster due to JIT warm-up)

> yourModule/clean; yourModule/compile
[info] Total time: 15 s, ...  // Third run (even faster)

> yourModule/clean; yourModule/compile
[info] Total time: 14 s, ...  // Fourth run (stabilization begins)

> yourModule/clean; yourModule/compile
[info] Total time: 14 s, ...  // Fifth run (convergence complete)
```

In this case, you can conclude that the stable compilation time for the module is approximately **14 seconds**.

## Going Further: Compilation Time Profiling

> [https://scalacenter.github.io/scalac-profiling/docs/user-guide/motivation.html](https://scalacenter.github.io/scalac-profiling/docs/user-guide/motivation.html)

If you want to analyze in detail which macros in the `sourcecode` library are particularly time-consuming, you can use a plugin like `scalac-profiling`. This allows you to visualize (e.g., with a flame graph) the time spent in each compilation phase or on macro expansion. This is very useful for finding performance improvement points after measuring the overall time.

## The Impact: Faster Debugging, Negligible Overhead

- This seemingly small change led to a **dramatic improvement in our debugging efficiency**. We no longer spend frustrating hours trying to trace ambiguous errors. Identifying the precise call site drastically cuts down investigation time.
- What's even better is that **existing code at all call sites did not require any modification at all.** Because `sourcecode` utilizes `implicit` parameters, the compiler automatically injects the necessary context without us having to touch a single line of code in the hundreds of places these functions were used.
- This made the adoption incredibly smooth. Crucially, implementing `sourcecode` across our substantial project incurred **almost no compile-time penalty**. Compile times increased by less than 3 seconds, proving that this gain in productivity came with virtually no performance cost.

## The Limitations

While `sourcecode` is incredibly helpful, it’s important to understand its boundaries. The most significant limitation is that it only captures the **immediate caller’s information**.

Because the compiler resolves the implicit at the exact point where the function is called, it doesn't "see" through multiple layers of abstraction. If you have a chain of calls (A → B → C), and only C uses `sourcecode`, you will see that B called C, but you won't automatically know that A was the original trigger.

### Strategic Placement: The "Base Utility" Rule

Due to this behavior, `sourcecode` is most effective when applied to **base utility functions** or **low-level primitives** that are invoked directly by business logic.

- **Good for:** Generic logging wrappers, database query executors, or HTTP client helpers. These are the "terminal" points of your internal infrastructure where knowing exactly which business service made the call is vital.
- **Less effective for:** Deeply nested internal logic where the immediate caller is just another private helper method. In those cases, the information provided might be too granular to be useful.

### A Concrete Example of the "Wrapper" Problem

```scala
// A base utility with sourcecode
def logError(msg: String)(implicit line: sourcecode.Line) = 
  println(s"Error at line ${line.value}: $msg")

// A wrapper function
def handleFailure(e: Throwable) = 
  logError(e.getMessage) // Implicit resolved HERE

// Business Logic
def processData() = {
  // ... something fails
  handleFailure(new Exception("DB Timeout")) 
}
```

In the example above, `logError` will always report the line number inside `handleFailure`, **not** the line in `processData` where the actual logic error occurred. To fix this, you would have to propagate the implicit all the way up, which can eventually lead to "implicit clutter."

`sourcecode` isn't a replacement for a full distributed trace or a ZIO-style fiber trace. However, when strategically placed in your project’s **base utility layer**, it provides the missing link between generic error messages and the specific call sites that triggered them—all with zero runtime cost.

## Conclusion

Debugging in functional effect systems like **ZPure** or **ZIO** presents a unique challenge: the very mechanism that ensures our application's safety—**the trampoline**—effectively hides the logical flow from the JVM's native stack trace. While this "flat" stack prevents `StackOverflowError`, it often leaves developers staring at ambiguous error messages without a clear origin.

By integrating the **`sourcecode`** library with Scala’s **implicit** system, I successfully bridged this gap. This approach allowed us to:

- **Automate Context Injection:** We no longer rely on developers to manually provide context strings under pressure.
- **Maintain Performance:** Rigorous sbt measurement proved that the compile-time impact is negligible (less than 3 seconds), while the runtime cost is zero.
- **Simplify Adoption:** Thanks to implicit propagation, I could enhance hundreds of call sites without changing a single line of business logic.

However, it is vital to remember the **"Base Utility Rule"**. Because `sourcecode` captures the immediate caller, it is most powerful when placed in the foundational layers of your architecture. In the end, the goal of my project isn't just to write "pure" code, but to write **maintainable and debuggable** systems. Leveraging compile-time information to enrich our error messages was a pragmatic and powerful step toward that goal.
