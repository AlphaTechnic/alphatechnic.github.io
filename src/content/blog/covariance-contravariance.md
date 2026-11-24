---
title: 'Covariance, Contravariance'
description: 'At its core, variance is about how the subtype relationship of a type parameter influences the subtype relationship of a generic type itself. It addresses...'
pubDate: 2025-06-22
tags: ['contravariance', 'Covariance', 'fp']
---

## Intro

At its core, **variance** is about **how the subtype relationship of a type parameter influences the subtype relationship of a generic type itself.** It addresses the question: when a subtype relationship is established for a type parameter (e.g., `Dog <: Animal`), how does this relationship translate to the generic type when that type parameter is injected into it? (e.g., `List[Dog] <: List[Animal]`)

The answer largely depends on how the type parameter is used within the generic type – whether it's primarily for **input** or **output**.

## Why Variance Matters in Functional Programming

While **variance** (covariance, contravariance, and invariance) aren't concepts exclusive to functional programming (FP), they appear particularly frequently and prominently in it. This is largely because FP heavily relies on **type class-based abstractions** like `Functor`, `Contravariant`, and `Monad`. These abstractions often operate with **type parameters**, and understanding what variance these parameters can have is crucial.

Consider Scala's `Function1` trait, which represents a function that takes one argument:

```scala
trait Function1[-A, +B] {
  def apply(a: A): B
}
```

This structure is a core abstraction in functional programming. Because FP often deals with composing and transforming functions and data within these type-parameterized structures, variance becomes much more apparent and essential for ensuring type safety and flexible code composition.

## Subtype

A **subtype** in programming means that a specific type can incorporate or extend all the functionalities of another type. In essence, it adheres to the principle that a child type (subtype) can safely be used anywhere a parent type (supertype) is expected. This is also known as the **Liskov Substitution Principle**.

For example, imagine you have a type `Animal` and a type `Dog` that inherits from `Animal`. In this case, `Dog` is a subtype of `Animal`. Any function designed to accept an `Animal` object should seamlessly accept a `Dog` object without causing issues.

## Variance: Covariance, Contravariance, and Invariance

Let's dive into the specifics of each variance type:

- **Covariance**: The subtype relationship of the type argument is preserved in the **same direction** for the generic type.
    - If `Child` is a subtype of `Parent`, then `Decoder[Child]` is a subtype of `Decoder[Parent]`.
    - This typically appears in **creation** contexts (e.g., when taking elements _out_ of a `Decoder`).
- **Contravariance**: The subtype relationship of the type argument is preserved in the **opposite direction** for the generic type.
    - If `Child` is a subtype of `Parent`, then `Encoder[Parent]` is a subtype of `Encoder[Child]`.
    - This is because an `Encoder` that can handle `Parent` can certainly handle `Child` (which is a more specific type of `Parent`).
    - This typically appears in **input** contexts (e.g., when putting elements _into_ an `Encoder`).
- **Invariance**: The subtype relationship of the type argument has **no effect** on the subtype relationship of the generic type.
    - If `Child` is a subtype of `Parent`, `Array[Child]` is neither a subtype nor a supertype of `Array[Parent]`. (While Scala's `Array` is invariant, Java's `Array` is covariant, which can lead to runtime errors and should be handled with care.)
    - This usually occurs in contexts where both reading and writing are possible. Invariance is often the default to ensure type safety.

## Examples

`Encoder` and `Decoder` are common examples used to illustrate interfaces that transform one type into another. Let's consider JSON serialization/deserialization.

### Decoder (Covariant)

A `Decoder` is responsible for transforming an input (e.g., a JSON string) into an object of a specific type. You can think of it as **producing** data. In Scala, we use the `+` symbol to denote covariance.

```scala
trait Decoder[+A] { // The '+' symbol indicates Covariance.
  def decode(s: String): A
}

val dogDecoder: Decoder[Dog] =
  (s: String) => new Dog

val animalDecoder: Decoder[Animal] =
  dogDecoder   // Ok (Covariant)
```

In the example above, passing a `Decoder[Dog]` type `dogDecoder` to the `animalDecoder` , which accepts a `Decoder[Animal]`, is possible because `Decoder` has **Covariance** (indicated by the `+A` keyword).

### Encoder (Contravariant)

An `Encoder` is responsible for transforming an object of a specific type into another form (e.g., a JSON string). It can be seen as taking **input** to process. In Scala, we use the symbol to denote contravariance.

```scala
trait Encoder[-A] { // The '-' symbol indicates Contravariance.
  def encode(value: A): String
}

val animalEncoder: Encoder[Animal] =
  (a: Animal) => "{}"

val dogEncoder: Encoder[Dog] =
  animalEncoder   // Ok (Contravariant)
```

In the example above, passing an `Encoder[Animal]` type `animalEncoder` to the `dogEncoder` , which accepts an `Encoder[Dog]`, is possible because `Encoder` has **Contravariance** (indicated by the `A` keyword). An encoder that can encode an `Animal` can, of course, also encode a `Dog` (a subtype of `Animal`), thus ensuring type safety.

## Understanding `map` and `contramap`

In functional programming, `map` and `contramap` are core operations of Functors and Contravariant Functors, respectively. They are used to "compose" new transformations onto existing type conversion logic.

The reason `Decoder` naturally supports `map` while `Encoder` naturally supports `contramap` lies in the **direction of data flow**. Whether a type is an **Output (Producer)** or an **Input (Consumer)** determines which operation makes sense.

### Decoder and `map`: "Refining the Output"

A `Decoder[A]` is fundamentally a **Producer**.

- **Process:** It takes a raw input (like a JSON string), processes it, and **outputs** an object of type `A`.
- **Expansion:** If we want a `Decoder[B]`, we simply take the existing output `A` and transform it into `B`.
- **Flow:** `String` → **\[Decoder\]** → `A` → **\[f: A => B\]** → `B`

This is the "forward" flow we are used to in `List.map` or `Option.map`. We attach the transformation at the _end_ of the pipeline where the result comes out.

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

Because the type parameter `A` is in the **output position**, the transformation moves in the same direction as the data.

### Encoder and `contramap`: "Preparing the Input"

An `Encoder[A]` is fundamentally a **Consumer**.

- **Process:** It **inputs** an object of type `A` and converts it into a raw format (like a JSON string).
- **Expansion:** What if we want an `Encoder[B]`? We want to handle `B`, but our tool only knows how to handle `A`.
- **Solution:** As soon as `B` enters the pipeline, we quickly transform it into `A` _before_ handing it over to the original encoder.
- **Flow:** `B` → **\[f: B => A\]** → `A` → **\[Encoder\]** → `String`

We are attaching the transformation at the _entrance_ of the pipeline. Since we are mapping "against" the data flow (transforming the input before it is consumed), we call it **contra-map**.

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

Because the type parameter `A` is in the **input position**, the transformation must happen "upstream," resulting in the reverse-direction mapping.

### Summary

| **Feature** | **Decoder\[A\]** | **Encoder\[A\]** |
| --- | --- | --- |
| **Role** | Producer (Output) | Consumer (Input) |
| **Data Direction** | Internal → External | External → Internal |
| **Logic Timing** | _After_ production (`A => B`) | _Before_ consumption (`B => A`) |
| **Natural Operation** | **map** (Covariant) | **contramap** (Contravariant) |

## Scala's `Function1` trait

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
- It's safe because if it promises an `Animal`, and it gives you a `Dog` (a more specific `Animal`), that's perfectly fine.
- So, `Function1[Dog, Dog]` is a subtype of `Function1[Dog, Animal]`. The subtype relationship for the output type goes in the _same_ direction.

```scala
val handleAnimal: Animal => Dog =
  animal => new Dog

val f: Dog => Dog = handleAnimal // Ok
```

The input type `Args` is **contravariant (**`-Args`**)**: This means a function that expects a **more specific** type for its input can be replaced by a function that expects a **more general** type.

- If you have a function `Animal => Dog`, it can be used where `Dog => Dog` is expected.
- It's safe because if it can process _any animal_ type (`Animal`), it can certainly process a `Dog` (which is a specific `Animal`).
- So, `Function1[Animal, Int]` is a subtype of `Function1[Dog, Int]`.
- The subtype relationship for the input type goes in the _opposite_ direction.

## Conclusion

- Variance in type parameters is a powerful concept that enables greater flexibility and type safety in object-oriented and functional programming paradigms.
- While the core ideas of covariance, contravariance, and invariance exist independently, they are especially prominent in functional programming due to its heavy reliance on generic abstractions and the composition of functions.
- Understanding how input and output types behave with respect to subtyping, as clearly demonstrated by Scala's `Function1` trait, is fundamental for designing robust and extensible functional code.
- By embracing these principles, developers can write more adaptable and predictable programs, making type-driven development a more seamless experience.
