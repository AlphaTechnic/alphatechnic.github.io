---
title: 'Covariance, Contravariance'
description: 'What covariance and contravariance mean, and why they depend on whether a type is used as an output or an input.'
pubDate: 2025-06-22
tags: ['contravariance', 'Covariance', 'fp']
---

## Intro

At its core, **variance** is about **how the subtype relationship of a type parameter affects the subtype relationship of a generic type itself.** Suppose a type parameter has a subtype relationship (e.g., `Dog <: Animal`). We then put that type parameter into a generic type. Variance asks how the relationship carries over to the generic type. (e.g., `List[Dog] <: List[Animal]`)

The answer depends largely on how the type parameter is used within the generic type. What matters is whether it's mainly for **input** or **output**.

## Why Variance Matters in Functional Programming

**Variance** (covariance, contravariance, and invariance) is not a concept that belongs only to functional programming (FP). But it appears especially often and clearly in FP. This is largely because FP relies heavily on **type class-based abstractions** like `Functor`, `Contravariant`, and `Monad`. These abstractions often work with **type parameters**. It is very important to understand what variance these parameters can have.

Consider Scala's `Function1` trait, which represents a function that takes one argument:

```scala
trait Function1[-A, +B] {
  def apply(a: A): B
}
```

This structure is a core abstraction in functional programming. FP often composes and transforms functions and data within these type-parameterized structures. Because of this, variance becomes much easier to notice. It also becomes much more essential for type safety and flexible code composition.

## Subtype

In programming, a **subtype** is a specific type that can include or extend all the functionality of another type. It follows one basic principle. You can safely use a child type (subtype) anywhere a parent type (supertype) is expected. This is also known as the **Liskov Substitution Principle**.

For example, imagine you have a type `Animal` and a type `Dog` that inherits from `Animal`. In this case, `Dog` is a subtype of `Animal`. Any function designed to accept an `Animal` object should also accept a `Dog` object without problems.

## Variance: Covariance, Contravariance, and Invariance

Let's look at each variance type in detail:

- **Covariance**: The generic type keeps the subtype relationship of the type argument in the **same direction**.
    - If `Child` is a subtype of `Parent`, then `Decoder[Child]` is a subtype of `Decoder[Parent]`.
    - This typically appears in **creation** contexts (e.g., when taking elements _out_ of a `Decoder`).
- **Contravariance**: The generic type keeps the subtype relationship of the type argument in the **opposite direction**.
    - If `Child` is a subtype of `Parent`, then `Encoder[Parent]` is a subtype of `Encoder[Child]`.
    - This is because an `Encoder` that can handle `Parent` can certainly handle `Child` (which is a more specific type of `Parent`).
    - This typically appears in **input** contexts (e.g., when putting elements _into_ an `Encoder`).
- **Invariance**: The subtype relationship of the type argument has **no effect** on the subtype relationship of the generic type.
    - If `Child` is a subtype of `Parent`, `Array[Child]` is neither a subtype nor a supertype of `Array[Parent]`. (Scala's `Array` is invariant. Java's `Array`, however, is covariant. That covariance can lead to runtime errors and should be handled with care.)
    - This usually happens in contexts where both reading and writing are possible. Invariance is often the default to ensure type safety.

## Examples

`Encoder` and `Decoder` are common examples used to show interfaces that transform one type into another. Let's consider JSON serialization/deserialization.

### Decoder (Covariant)

A `Decoder` transforms an input (e.g., a JSON string) into an object of a specific type. You can think of it as **producing** data. In Scala, we use the `+` symbol to show covariance.

```scala
trait Decoder[+A] { // The '+' symbol indicates Covariance.
  def decode(s: String): A
}

val dogDecoder: Decoder[Dog] =
  (s: String) => new Dog

val animalDecoder: Decoder[Animal] =
  dogDecoder   // Ok (Covariant)
```

In the example above, `dogDecoder` has the type `Decoder[Dog]`, and `animalDecoder` accepts a `Decoder[Animal]`. We can pass the first to the second because `Decoder` has **Covariance** (indicated by the `+A` keyword).

### Encoder (Contravariant)

An `Encoder` transforms an object of a specific type into another form (e.g., a JSON string). You can think of it as taking **input** to process. In Scala, we use the `-` symbol to show contravariance.

```scala
trait Encoder[-A] { // The '-' symbol indicates Contravariance.
  def encode(value: A): String
}

val animalEncoder: Encoder[Animal] =
  (a: Animal) => "{}"

val dogEncoder: Encoder[Dog] =
  animalEncoder   // Ok (Contravariant)
```

In the example above, `animalEncoder` has the type `Encoder[Animal]`, and `dogEncoder` accepts an `Encoder[Dog]`. We can pass the first to the second because `Encoder` has **Contravariance** (indicated by the `-A` keyword). An encoder that can encode an `Animal` can, of course, also encode a `Dog` (a subtype of `Animal`). This ensures type safety.

## Understanding `map` and `contramap`

In functional programming, `map` is a core operation of Functors, and `contramap` is a core operation of Contravariant Functors. We use them to "compose" new transformations onto existing type conversion logic.

`Decoder` naturally supports `map`, while `Encoder` naturally supports `contramap`. The reason is the **direction of data flow**. A type can be an **Output (Producer)** or an **Input (Consumer)**, and this determines which operation makes sense.

### Decoder and `map`: "Refining the Output"

A `Decoder[A]` is fundamentally a **Producer**.

- **Process:** It takes a raw input (like a JSON string), processes it, and **outputs** an object of type `A`.
- **Expansion:** If we want a `Decoder[B]`, we simply take the existing output `A` and transform it into `B`.
- **Flow:** `String` → **\[Decoder\]** → `A` → **\[f: A => B\]** → `B`

This is the "forward" flow we are used to in `List.map` or `Option.map`. We attach the transformation at the _end_ of the pipeline, where the result comes out.

```scala
trait Decoder[+A] {
  def decode(data: String): A

    // When we have Decoder[A], applying map(f: A => B) looks like this:
    def map[B](f: A => B): Decoder[B] = new Decoder[B] {
      override def decode(data: String): B = {
        val a = Decoder.this.decode(data) // 1. Produce A first
        f(a)                              // 2. Transform A to B (Forward)
      }
    }
}
```

The type parameter `A` is in the **output position**. Because of this, the transformation moves in the same direction as the data.

### Encoder and `contramap`: "Preparing the Input"

An `Encoder[A]` is fundamentally a **Consumer**.

- **Process:** It **inputs** an object of type `A` and converts it into a raw format (like a JSON string).
- **Expansion:** What if we want an `Encoder[B]`? We want to handle `B`, but our tool only knows how to handle `A`.
- **Solution:** As soon as `B` enters the pipeline, we quickly transform it into `A`. We do this _before_ we hand it to the original encoder.
- **Flow:** `B` → **\[f: B => A\]** → `A` → **\[Encoder\]** → `String`

We are attaching the transformation at the _entrance_ of the pipeline. We are mapping "against" the data flow (we transform the input before it is consumed). That is why we call it **contra-map**.

```scala
trait Encoder[-A] {
  def encode(value: A): String

    // When we have Encoder[A], applying contramap(f: B => A) looks like this:
    def contramap[B](f: B => A): Encoder[B] = new Encoder[B] {
      def encode(value: B): String = {
        val a = f(value)             // 1. Transform B to A first (Reverse prep)
        Encoder.this.encode(a)       // 2. Consume A to produce String
      }
    }
}
```

The type parameter `A` is in the **input position**. Because of this, the transformation must happen "upstream." The result is the reverse-direction mapping.

### Summary

| **Feature** | **Decoder\[A\]** | **Encoder\[A\]** |
| --- | --- | --- |
| **Role** | Producer (Output) | Consumer (Input) |
| **Data Direction** | Internal → External | External → Internal |
| **Logic Timing** | _After_ production (`A => B`) | _Before_ consumption (`B => A`) |
| **Natural Operation** | **map** (Covariant) | **contramap** (Contravariant) |

## Scala's `Function1` Trait

Consider Scala's `Function1` trait again, which represents a function that takes one argument:

```scala
trait Function1[-Args, +Res] {
  def apply(a: Args): Res
}
```

```scala
val returnDog: Dog => Dog =
  dog => new Dog

val f: Dog => Animal = returnDog // Ok
```

The output type `Res` is **covariant (**`+Res`**)**: This means the function can return a **more specific** type than specified.

- If you have a function `Dog => Dog`, you can use it where `Dog => Animal` is expected.
- It's safe because it's perfectly fine to promise an `Animal` and give you a `Dog` (a more specific `Animal`).
- So, `Function1[Dog, Dog]` is a subtype of `Function1[Dog, Animal]`. The subtype relationship for the output type goes in the _same_ direction.

```scala
val handleAnimal: Animal => Dog =
  animal => new Dog

val f: Dog => Dog = handleAnimal // Ok
```

The input type `Args` is **contravariant (**`-Args`**)**: Suppose a function expects a **more specific** type for its input. Contravariance means you can replace it with a function that expects a **more general** type.

- If you have a function `Animal => Dog`, you can use it where `Dog => Dog` is expected.
- It's safe because if it can process _any animal_ type (`Animal`), it can certainly process a `Dog` (which is a specific `Animal`).
- So, `Function1[Animal, Int]` is a subtype of `Function1[Dog, Int]`.
- The subtype relationship for the input type goes in the _opposite_ direction.

## Conclusion

- Variance in type parameters is a powerful concept. It allows greater flexibility and type safety in object-oriented and functional programming paradigms.
- The core ideas of covariance, contravariance, and invariance exist independently. But they are especially prominent in functional programming. This is because functional programming relies heavily on generic abstractions and the composition of functions.
- Scala's `Function1` trait clearly shows how input and output types behave with respect to subtyping. Understanding this behavior is fundamental for designing robust and extensible functional code.
- By following these principles, developers can write more adaptable and predictable programs. This makes type-driven development a smoother experience.
