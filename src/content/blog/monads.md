---
title: 'The Way I Understand Monads'
description: 'What is a Monad, and why is it defined that way? I work through both questions, from flatMap and Option to IO and ZIO.'
pubDate: 2025-06-22
tags: ['fp', 'monad']
---

## Intro

There is a powerful way to understand a concept, especially an abstract one. You ask two simple but deep questions:

1. **What is its definition?**
2. **Why is it defined that way, and what’s the benefit?**

These two questions aren’t just useful for mathematics. They work equally well for functional programming (FP), where abstract structures like _Monads_ are central. In this post, I aim to explore Monads through these two questions.

## The Definition: A Universal Interface for Composition

The technical definition of a Monad is objective and short. In Scala, it is essentially a type constructor `F[_]` that provides two main operations:

```scala
trait Monad[F[_]] {
  def pure[A](a: A): F[A]
  def flatMap[A, B](fa: F[A])(f: A => F[B]): F[B]
}
```

- **`pure` (or `unit`):** Lifts a raw value into a context. It’s the entry point (e.g., `Option(1)`, `Right(10)`).
- **`flatMap` (or `bind`):** This operation does the main work. It takes a value that is already inside a context `F[A]`. It extracts the `A` to apply a transformation, and returns a new context `F[B]`.

Here’s a simple usage with the `Option` type:

```scala
val result: Option[Int] = 
    for {
      a <- Option(1)
      b <- Option(2)
    } yield a + b // result: Some(3)
```

NOTE: This `for` comprehension is syntactic sugar for a chain of `flatMap` calls.

## What’s the Benefit of This Definition?

However, _why_ it's defined this way is more subjective, and people can interpret it differently. But I believe this subjective part is where you find the real understanding. Without that, a `Monad` remains something you’ve memorized, not something you know how to _use_. Now to the main question: **why does this particular definition matter?**

Let’s look again at the signature of `flatMap` (since the `pure` part is very simple):

```scala
flatMap: F[A] => (A => F[B]) => F[B]
```

This means:

- You have a value with _effects_: `F[A]`.
- You want to extract it and use the plain value `A`. Then you want to perform the next step: `A => F[B]`.
- The result is still in the same context `F`.

In other words, you have a value `A` inside a context `F`. You can transform it into a new value `B` while **preserving the context** during the whole process. Because the context is preserved, **sequential chaining of operations** is possible. Each step may carry its own context, such as effects, optionality, failure, or asynchrony. The contextual information is not lost or flattened too early.

So `flatMap` is fundamentally about **context-aware transformation and composition**. It allows you to chain computations cleanly. At the same time, it respects the underlying effects that the context `F` encapsulates.

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

Monad structure allows us to **safely and sequentially chain computations**. But when does that _really_ matter? It starts to show its true power when we begin to work with **IO Monads**. Reading from or writing to the console, accessing a database, and calling an external API are all **side effects**. At first, they seem to conflict with FP at a basic level. They depend on time, state, or the outside world, and FP traditionally avoids these things.

Thanks to the Monad abstraction, we can model these operations as **values**. We don’t run them immediately. Instead, we **describe** them. Look at the difference here:

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

In the example above, `program` is not an action. It is a **blueprint**. We can chain these blueprints **safely and predictably** using `flatMap`, and we never leave the pure functional world. Again, the result of that chaining is not an action. It’s still a **value**: a description of what could happen. The program becomes a large blueprint of "what to do." It is only executed at the very end (the "end of the world").

This separation gives us:

- **Control:** We decide exactly _when_ the blueprint is executed (usually at the "end of the world," like the `main` method).
- **Transparency:** When we look at the type `IO[Unit]`, we know exactly that this value involves a side effect.
- **Testability:** We can manipulate, retry, or mock these descriptions. We can do this without actually triggering network calls or database writes during every test run.

## ZIO: The Evolution of the Monadic Contract

Modern effects libraries like **ZIO** take this further. They add more "dimensions" to the context. A `ZIO[R, E, A]` isn't just a value. It's a **semantic contract**:

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

The _effect_ is still just described. It is not executed yet. But the **type** tells us everything: what it needs, how it can break, and what it promises. `Monad`s make this kind of precision and clarity possible. They enable not just composition of values, but also **composition of effects**.

This `for` comprehension chains together multiple effectful steps. Each step depends on the result of the previous one. The entire computation is still a _single ZIO effect_. This makes it composable and type-safe.

## Conclusion

The Monad is more than just a functional design pattern. It is a **unifying abstraction**. You may be dealing with any of these:

- **Option:** Handling the context of "Maybe"
- **Either:** Handling the context of "Failure"
- **List:** Handling the context of "Multiple Values"
- **ZIO/IO:** Handling the context of "Side Effects"

In all these cases, the interface remains the same. Once you learn how to `flatMap` one, you can `flatMap` them all. It allows us to build complex, effectful systems. These systems remain as predictable and composable as simple arithmetic.
