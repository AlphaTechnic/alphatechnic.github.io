---
title: 'The Way I Understand Monads'
description: 'One powerful way to understand a concept—especially abstract ones—is to ask two simple but profound questions:'
pubDate: 2025-06-22
tags: ['fp', 'monad']
---

## Intro

One powerful way to understand a concept—especially abstract ones—is to ask two simple but profound questions:

1. **What is its definition?**
2. **Why is it defined that way—what’s the benefit?**

This dual approach isn’t just useful for mathematics. It applies equally well to functional programming (FP), where abstract structures like _Monads_ are central. In this post, I aim to explore Monads through these two questions.

## The Definition: A Universal Interface for Composition

The technical definition of a Monad is objective and concise. In Scala, it is essentially a type constructor `F[_]` that provides two primary operations:

```scala
trait Monad[F[_]] {
  def pure[A](a: A): F[A]
  def flatMap[A, B](fa: F[A])(f: A => F[B]): F[B]
}
```

- **`pure` (or `unit`):** Lifts a raw value into a context. It’s the entry point (e.g., `Option(1)`, `Right(10)`).
- **`flatMap` (or `bind`):** This is where the magic happens. It takes a value already inside a context `F[A]`, extracts the `A` to apply a transformation, and returns a new context `F[B]`.

Here’s a simple usage with the `Option` type:

```scala
val result: Option[Int] = 
    for {
      a <- Option(1)
      b <- Option(2)
    } yield a + b // result: Some(3)
```

NOTE: This `for` comprehension is syntactic sugar for a chain of `flatMap` calls.

## What’s The Benefit of This Definition?

However, _why_ it's defined this way is more subjective and open to interpretation. But I believe this subjectivity is where the real understanding lies. Without that, a `Monad` remains something you’ve memorized, not something you know how to _use_. Now to the core question: **why does this particular definition matter?**

Let’s look again at the signature of `flatMap` (since `pure` part is trivial):

```scala
flatMap: F[A] => (A => F[B]) => F[B]
```

This means:

- You have a value with _effects_—`F[A]`.
- You want to extract it, use the plain value `A`, and perform the next step: `A => F[B]`.
- The result is still in the same context `F`.

In other words, given a value `A` embedded in a context `F`, you can transform it into a new value `B`, while **preserving the context** throughout the process. This preservation enables **sequential chaining of operations** where each step may carry its own context—be it effects, optionality, failure, or asynchrony—without losing or flattening the contextual information prematurely.

Hence, `flatMap` is fundamentally about **context-aware transformation and composition**, allowing you to chain computations cleanly while respecting the underlying effects encapsulated by the context `F`.

### Before Monads: The Pyramid of Doom

Without Monads, handling optionality or errors often looks like this:

```scala
val result = userRepo.findById(id) match {
  case Some(user) => 
    orderRepo.findLastOrder(user.id) match {
      case Some(order) => calculateDiscount(order)
      case None => None
    }
  case None => None
}
```

### After Monads: The Linear Flow

Using the Monadic interface (via for-comprehension), the logic becomes a clean, linear pipeline:

```scala
val result = 
    for {
      user     <- userRepo.findById(id)
      order    <- orderRepo.findLastOrder(user.id)
      discount <- calculateDiscount(order)
    } yield discount
```

## The IO Monad: Modeling Time and Side Effects

Monad structure allows us to **safely and sequentially chain computations** — but when does that _really_ matter? It starts to show its true power when we enter the world of **IO Monads**. Reading from or writing to the console, accessing a database, calling an external API — these are **side effects**, and at first glance, they seem fundamentally at odds with FP. They depend on time, state, or the outside world — things FP traditionally avoids.

Thanks to the Monad abstraction, we can model these operations as **values**. We don’t run them immediately; we **describe** them. Consider the difference here:

```scala
// 1. Impure/Eager: This runs IMMEDIATELY when defined
val name = scala.io.StdIn.readLine() 

// 2. Pure/Lazy: This is just a DESCRIPTION of how to get a name
case class IO[A](run: () => A) {
  def flatMap[B](f: A => IO[B]): IO[B] = IO(() => f(run()).run())
  def map[B](f: A => B): IO[B] = IO(() => f(run()))
}

val getName: IO[String] = IO(() => scala.io.StdIn.readLine())
val putText: String => IO[Unit] = s => IO(() => println(s))

// The Chain: Still just a value. Nothing has happened yet!
val program: IO[Unit] = 
    for {
      _    <- putText("What is your name?")
      name <- getName
      _    <- putText(s"Hello, $name")
    } yield ()
```

In the example above, `program` is not an action—it is a **blueprint**. We can chain these blueprints safely and predictably using `flatMap` without ever leaving the pure functional world. Thanks to the **Monad abstraction**, we can model these operations as **values**. We don’t run them immediately — we _describe_ them. And more importantly, we can chain them **safely and predictably**, using `flatMap`, without ever leaving the pure functional world. The result of that chaining is not an action — again, it’s still a **value**: a description of what could happen. The program becomes a large blueprint of "what to do," which is only executed at the very end (the "end of the world").

This separation gives us:

- **Control:** We decide exactly _when_ the blueprint is executed (usually at the "end of the world," like the `main` method).
- **Transparency:** By looking at the type `IO[Unit]`, we know exactly that this value involves a side effect.
- **Testability:** We can manipulate, retry, or mock these descriptions without actually triggering network calls or database writes during every test run.

## ZIO: The Evolution of the Monadic Contract

Modern effects libraries like **ZIO** take this further by adding more "dimensions" to the context. A `ZIO[R, E, A]` isn't just a value; it's a **semantic contract**:

- **R (Environment):** "What do I need to run?" (Dependency Injection)
- **E (Error):** "How might I fail?" (Typed Errors)
- **A (Value):** "What do I produce on success?"

```scala
val program: ZIO[Database, QueryError, User] = 
    for {
      db     <- ZIO.service[Database]
      raw    <- db.run(query)
      user   <- ZIO.fromEither(parseUser(raw))
    } yield user
```

The _effect_ is still just described — not yet executed. And yet, the **type** tells us everything: what it needs, how it can break, and what it promises. That’s the kind of precision and clarity `Monad`s enable — not just composition of values, but **composition of effects**.

This `for` comprehension chains together multiple effectful steps. Each step depends on the result of the previous one. And the entire computation is still a _single ZIO effect_, making it composable and type-safe.

## Conclusion

The Monad is more than just a functional design pattern; it is a **unifying abstraction**. Whether you are dealing with:

- **Option:** Handling the context of "Maybe"
- **Either:** Handling the context of "Failure"
- **List:** Handling the context of "Multiple Values"
- **ZIO/IO:** Handling the context of "Side Effects"

The interface remains the same. Once you learn how to `flatMap` one, you can `flatMap` them all. It allows us to build complex, effectful systems that remain as predictable and composable as simple arithmetic.
