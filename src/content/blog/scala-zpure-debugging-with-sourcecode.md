---
title: 'Solving the Ambiguous Error Problem in Trampolined Effects Using Compile-Time Macros'
description: 'ZPure errors did not show where they came from. I used implicit parameters and the sourcecode library to add the caller''s location.'
pubDate: 2025-06-22
tags: ['Implicit', 'scala', 'sourcecode']
---

## Intro

Scala's **`implicit`** keyword is very powerful. People often praise it because it makes elegant DSLs, type class patterns, and dependency injection possible. However, it is also useful beyond these common use cases. This might not always be clear right away to people new to Scala, or even to experienced developers.

I want to share a practical case where we used `implicit`s together with the **`sourcecode`** library. They greatly improved our team's development productivity by making our error messages far more useful.

## My Challenge: The Elusive Origin of Errors

In our project, we often use common utility functions across the codebase. These functions are convenient, but they often produced ambiguous error messages. Those messages made debugging very hard.

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

When an error occurred in `assertCandidatesNonEmpty`, we would see "`Invalid input. maximum must be greater than 0. [context: ]`". For `extractOption`, it was "`Can't extract option from None.`". The `context` parameter was often left at its default value, or developers with tight deadlines simply neglected it. So when an error appeared, we would spend valuable time asking: **"Where did this error even come from?"**

Of course, we could have made `context` mandatory. But then we would have to update hundreds of existing call sites by hand. We would also have to enforce strict `context` input during rapid development. This felt very difficult. Then one question comes up: **why doesn't the JVM call stack show the caller's information from the immediate previous layer?**

## ZPure Trampoline

### How Does ZPure Implement Its Trampoline?

Functional effect systems like **ZIO** and **ZPure** use a technique called a **trampoline**. It is a core mechanism to ensure **stack safety**. Deep, recursive calls make the JVM call stack grow. Instead of making such calls, a trampoline evaluates each step of a computation within a loop. This keeps the physical call stack flat.

- **Normal recursive function**

```scala

f(3)
 └ f(2)
    └ f(1)
       └ f(0)
```

⇒ The structure makes the stack grow deeper step by step.

- **Trampoline**

```scala
main
 └ run
     while (...) {
       current = nextStep()
     }
```

⇒ It always “jumps” to the next computation from the same location (i.e., the same stack frame). I’d like to cover this topic in a separate post later.

### Internal Loop Pseudo-Code

This execution process is implemented with a `while` loop. It looks something like the code below. The function `f` passed to `flatMap` or `map` is pushed onto a stack data structure. When the loop meets a `Succeed`, a function is popped from the stack and applied to the value.

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

### Why Debugging Is Difficult

The main point here is that **the JVM's call stack is separate from ZPure's logical evaluation plan stack.** The `caller` functions you write inside `map` and `flatMap` are just "data". They are stored in ZPure's internal execution “heap” stack (the `stack` variable). They are not functions that get pushed onto the JVM's physical call stack. The JVM call stack only contains a reference to the `run` method that started the `while` loop.

As a result, the JVM debugger's call stack is not enough, even when an error occurs in the `Fail` case. By looking only at that call stack, you cannot trace the logical `caller` (e.g., `map(_ * 2)`) that led to the failure. This leads to a natural question: "If an error occurs, why can't ZPure just show the contents of its internal evaluation plan stack?" A few technical limitations make this difficult.

### Then Why Doesn't ZPure Show Its Internal Stack?

- **Functions are Anonymous Objects on the JVM.**
    - The functions `f: A => ZPure[B]` stored on the stack are mostly anonymous classes or lambdas. The Scala compiler generates them. Calling `toString()` on these function objects gives unreadable strings like `com.example.MyClass$$anonfun$1@3ace9f98`. These strings are useless for a human.
- **Function Objects Don't Contain Source Code Location Information.**
    - By default, a Scala function object does not contain information about where it was defined in the source code (e.g., file and line number). So even if you could print the functions from the stack, it would be nearly impossible for a developer to know which part of the code they correspond to.
- **ZPure Does Not Expose a Debugging API.**
    - Internally, `ZPure` keeps a stack for continuations (`Stack[Continuation]`). But it does not expose this information externally through a debugging API for logging or tracing. (In contrast, `ZIO` provides the `ZTrace` object, which tracks this evaluation plan to help with debugging.)
- For these reasons, it's difficult for **ZPure** to show a clear, logical call stack when a failure happens. I needed a way to inject the necessary debugging information about the caller from code.

## The `implicit` Solution: Automatically Injecting Caller Context with `sourcecode`

My solution came from Scala's `implicit` parameters and the **`sourcecode`** library ([https://github.com/com-lihaoyi/sourcecode](https://github.com/com-lihaoyi/sourcecode)). `sourcecode` injects source code information (like file name, line number, and enclosing function name) at **compile time using macros**. This is very important because, as its documentation states:

> sourcecode does not rely on runtime reflection or stack inspection, and is done at compile-time using macros. This means that it is both orders of magnitude faster than e.g. getting file-name and line-numbers using stack inspection, and also works on Scala.js where reflection and stack inspection can't be used.

This makes it fast. It also makes it compatible with environments like `Scala.js`, where runtime reflection isn't an option. The important step is to include `sourcecode`'s types, like `sourcecode.FullName` and `sourcecode.Line`, as `implicit` parameters in a function signature. If no explicit value is provided for these `implicit`s in the calling scope, the compiler **automatically provides them**. It bases them on the current call site's information.

Here's how our code changed and how this affected our error messages

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

The real power of this approach is in how `implicit` parameters pass down the call chain. We add `implicit funcName: sourcecode.FullName` and `implicit codeLine: sourcecode.Line` to our functions. Here's what happens when we do this

When `chooseOne` is called, the compiler fills its `implicit` parameters. It uses the function name and line number of the caller (`Program.scala:157`). The next part is critical. `chooseOne` then calls `assertCandidatesNonEmpty`, which also expects these `implicit`s. At this point, the `funcName` and `codeLine` values are already in scope (from `chooseOne`'s caller). Scala's `implicit` resolution rules ensure that these values are **automatically passed along**.

This means the error message will contain the context of the **original call site** (`Program.scala:157`). This is true even if the error is thrown deep within `assertCandidatesNonEmpty`. The message does not just show the immediate caller of `assertCandidatesNonEmpty`. This lets us provide precise, user-friendly debugging information exactly where it's needed.

### Error Message Comparison

|     | **Before Change** | **After Change** |
| --- | --- | --- |
| `chooseOne` | "Invalid input. maximum must be greater than 0. \[context: \]" | "Invalid input. Called from **\[program.GachaPrograms:157\]**. Candidates are empty." |
| `extractOption` | "Can't extract option from None." | "Called from **\[extractors.GachaExtractor.extractGachaPools:207\]**. Can't extract option from None." |

The difference is very clear. Now we get an error message like "`Invalid input. Called from [program.GachaPrograms:157]...`". It immediately tells us not just _what_ went wrong, but **exactly _where_ the problematic function was called**. We can simply copy this location into our IDE and go straight to the source of the issue.

## Measuring Scala Compile Times Correctly

We need to check whether this change increases compile time. The goal is to measure the **'stable' time** it takes for source code to compile. We do this by removing two variables:

- **errors from JVM Warm-up**
- **interference from the external environment (e.g IDE)**

### Why Must It Be Run Within a Single `sbt` Session? (JVM & JIT Compiler Warm-Up)

- **JVM Cold Start:** Both `sbt` and the Scala compiler (`scalac`) run on the Java Virtual Machine (JVM). When you first run `sbt`, the JVM starts and loads many classes. It also spends a significant amount of time on initialization.
- **JIT (Just-In-Time) Compiler:** At first, the JVM interprets the code. Then it identifies code that is used often (**"Hotspots"**). It compiles that code into native machine code in real time to optimize performance. This JIT compilation process needs a **"warm-up"** period to become stable.
- ⇒ The first compilation is measured as very slow because the measurement includes three things. These are the JVM startup time, the JIT compilation optimization time, and the actual code compilation time. If you repeat compilations within the same `sbt` session, the JVM and JIT compiler are already warmed up. This lets you measure the pure compilation time without this overhead.

### Why Repeat `clean` and `compile` Multiple Times? (Convergence of Measured Values)

- **The Role of `clean`:** The `clean` command deletes all previous compilation artifacts (like compiled `.class` files). This ensures that the entire codebase is always recompiled from scratch. Without `clean`, Scala's incremental compilation feature would only compile the changed parts. The measurement would then be much shorter and inaccurate.
- **The Role of Repetition:** As explained above, the JIT compiler needs time to fully warm up and give stable performance. This usually takes two to three or more runs. The compilation time will gradually decrease over the first few runs. Then it will **"converge"** to an almost constant time.
- ⇒ After 4-5 repetitions, the measured time no longer decreases and has become stable. At that point, you can reliably treat that value as the stable, full compilation time for that module.

### Why Should You Close IDEs like IntelliJ? (Excluding External Interference)

- **Background Compilation:** IntelliJ shows errors in real time as you write code. To do this, it continuously runs its own internal compiler in the background. This process uses CPU and memory resources.
- **Resource Contention:** Suppose IntelliJ is running when you run `sbt compile` in the terminal. The command will then compete for resources (CPU, disk I/O) with the IDE's background tasks.
- ⇒ This external interference adds **"noise"** to the compilation time measurement and makes it less reliable. Accurate measurement needs a controlled environment where other processes have very little influence. Closing the IDE is the most effective way to achieve this.

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

In this case, you can conclude that the stable compilation time for the module is about **14 seconds**.

## Going Further: Compilation Time Profiling

> [https://scalacenter.github.io/scalac-profiling/docs/user-guide/motivation.html](https://scalacenter.github.io/scalac-profiling/docs/user-guide/motivation.html)

You may want to analyze in detail which macros in the `sourcecode` library take an especially long time. In that case, you can use a plugin like `scalac-profiling`. It lets you visualize (e.g., with a flame graph) the time spent in each compilation phase or on macro expansion. This is very useful for finding places to improve performance after you measure the overall time.

## The Impact: Faster Debugging, Negligible Overhead

- This change seems small, but it led to a **very large improvement in our debugging efficiency**. We no longer spend frustrating hours trying to trace ambiguous errors. Finding the exact call site greatly reduces investigation time.
- Even better, **existing code at all call sites did not need any changes at all.** `sourcecode` uses `implicit` parameters, so the compiler automatically injects the necessary context. These functions were used in hundreds of places, and we did not have to touch a single line of code there.
- This made the adoption very smooth. Most importantly, adding `sourcecode` across our large project caused **almost no compile-time penalty**. Compile times increased by less than 3 seconds. This proves that the productivity gain came with virtually no performance cost.

## The Limitations

While `sourcecode` is extremely helpful, it’s important to understand its limits. The most significant limitation is that it only captures the **immediate caller’s information**.

The compiler resolves the implicit at the exact point where the function is called. Because of this, it doesn't "see" through multiple layers of abstraction. Suppose you have a chain of calls (A → B → C), and only C uses `sourcecode`. You will see that B called C, but you won't automatically know that A was the original trigger.

### Strategic Placement: The "Base Utility" Rule

Because of this behavior, `sourcecode` is most effective in **base utility functions** or **low-level primitives** that business logic calls directly.

- **Good for:** Generic logging wrappers, database query executors, or HTTP client helpers. These are the "terminal" points of your internal infrastructure. There, it is vital to know exactly which business service made the call.
- **Less effective for:** Deeply nested internal logic where the immediate caller is just another private helper method. In those cases, the information might be too detailed to be useful.

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

In the example above, `logError` will always report the line number inside `handleFailure`. It will **not** report the line in `processData` where the actual logic error occurred. To fix this, you would have to propagate the implicit all the way up. This can eventually lead to "implicit clutter."

`sourcecode` isn't a replacement for a full distributed trace or a ZIO-style fiber trace. However, it is useful when you place it strategically in your project’s **base utility layer**. There, it provides the missing link between generic error messages and the specific call sites that triggered them. It does all this with zero runtime cost.

## Conclusion

Debugging in functional effect systems like **ZPure** or **ZIO** presents a unique challenge. The mechanism that ensures our application's safety is **the trampoline**. But this same mechanism effectively hides the logical flow from the JVM's native stack trace. This "flat" stack prevents `StackOverflowError`. However, it often leaves developers with ambiguous error messages that have no clear origin.

I successfully solved this problem by integrating the **`sourcecode`** library with Scala’s **implicit** system. This approach allowed us to:

- **Automate Context Injection:** We no longer rely on developers to provide context strings by hand under pressure.
- **Maintain Performance:** Careful sbt measurement proved that the compile-time impact is negligible (less than 3 seconds). The runtime cost is zero.
- **Simplify Adoption:** Thanks to implicit propagation, I could improve hundreds of call sites without changing a single line of business logic.

However, it is vital to remember the **"Base Utility Rule"**. `sourcecode` captures the immediate caller, so it is most powerful in the base layers of your architecture. In the end, the goal of my project isn't just to write "pure" code. The goal is to write **maintainable and debuggable** systems. We used compile-time information to add useful detail to our error messages. This was a practical and powerful step toward that goal.
