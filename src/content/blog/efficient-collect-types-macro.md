---
title: 'One Pass, N Types: Efficient Type Filtering with Scala 3 Macros'
description: 'When developing, we often need to iterate over a collection and pick out only the elements of specific types. This seems like a simple task, but what''s the...'
pubDate: 2025-08-17
tags: ['macro', 'scala']
---

## Intro

When developing, we often need to iterate over a collection and pick out only the elements of specific types. This seems like a simple task, but what's the best way to write the code? In this post, I'll share the steps I took. I start from inefficient code and move to a final solution that is **type-safe, efficient, and reusable**. The final solution uses Scala 3 macros.

## The Start of the Problem: Inefficient Type Filtering

First, let's define a simple shape hierarchy that we'll use for our examples.

```scala
sealed trait Shape

object Shape {
    case class Circle(radius: Double) extends Shape 

    case class Square(side: Double) extends Shape

    sealed trait Polygon extends Shape
    object Polygon {
      case class Triangle(a: Double, b: Double, c: Double) extends Polygon
    }
}

// A type unrelated to the Shape hierarchy
sealed trait NotShape
```

Imagine we have an `Iterable[Shape]`. We want to extract all the elements of type `Shape.Circle`, `Shape.Square`, and `Shape.Polygon.Triangle`. The most intuitive code I first came up with was this:

```scala
val shapes: Iterable[Shape] = getShapes() // A function that returns a list of shapes

val circles    = shapes.collect { case c: Shape.Circle => c }
val squares    = shapes.collect { case s: Shape.Square => s }
val triangles  = shapes.collect { case t: Shape.Polygon.Triangle => t }
```

The biggest problem with this code is clear. Each shape type is mutually exclusive, so we could complete the task in a single pass. But this code **iterates through the `shapes` collection three separate times**. As the amount of data grows, this inefficiency becomes a direct cause of worse performance.

## First Improvement: One-Pass Iteration with `foldLeft`

To improve performance, I wrote code that uses `foldLeft` to do the collection in a single pass.

```scala
val (circles, squares, triangles) =
  shapes.foldLeft(
    (List.empty[Shape.Circle], List.empty[Shape.Square], List.empty[Shape.Polygon.Triangle])
  ) { case ((cs, ss, ts), shape) =>
    shape match {
      case c: Shape.Circle           => (c :: cs, ss, ts)
      case s: Shape.Square           => (cs, s :: ss, ts)
      case t: Shape.Polygon.Triangle => (cs, ss, t :: ts)
      case _                         => (cs, ss, ts)
    }
  }
```

This code certainly has the advantage of getting the result we want in a single pass. However, I wasn't very happy with it for two clear reasons:

- **Verbose Code**: As more types are added, the initial tuple for `foldLeft` and the `case` statements get longer and longer.
- **Not Intuitive**: `foldLeft` is typically used for **aggregating** values. Here, it's being used simply for '**collecting**' by type. This makes its intent harder to see.

I wanted to create a method that was both intuitive and efficient. I wanted something like `.collectTypes[Circle, Square, Triangle]`.

## Second Improvement: Extension Methods with `implicit class`

To add new functionality to `Iterable[A]`, I decided to use an `implicit class`.

> What is an implicit class?
> 
> An `implicit class` is a powerful Scala feature. It allows you to add new methods to existing classes without changing their source code. The compiler may see a call to a method that doesn't exist on an object. When this happens, it looks for an `implicit class` in scope that can "wrap" the object to provide that method. This is also known as the '**Extension Method**' pattern.

Using an `implicit class`, I created a `collectTypes` method that could handle two types.

```scala
implicit class IterableOps[A](iterable: Iterable[A]) extends AnyVal {
  def collectTypes[T1 <: A: ClassTag, T2 <: A: ClassTag]: (List[T1], List[T2]) = {
    val b1 = List.newBuilder[T1]
    val b2 = List.newBuilder[T2]

    iterable.foreach {
      case t1: T1 => b1 += t1
      case t2: T2 => b2 += t2
      case _      =>
    }

    (b1.result(), b2.result())
  }
}
```

This code worked very well. However, it had a clear limitation: **the number of types you could filter for was fixed**. To handle three types, I'd have to create another overloaded method with three parameters. What if I needed to filter for 4, 5, or even 20 types? At this point, I decided I needed to use a technique that generates code at compile time: **Macros**.

## Third Improvement: First Steps with Scala 3 Macros

> What is a Scala Macro?
> 
> A macro is "code that writes code." It runs **at compile time** to change a program's Abstract Syntax Tree (AST) and generate new code. This allows you to remove repetitive boilerplate. You can reach high levels of abstraction with no runtime penalty. You can also implement powerful, type-based logic at compile time.

My goal was to create the following interface:

```scala
implicit class IterableOps[A](iterable: Iterable[A]) extends AnyVal {
  inline def collectTypes[Ts <: Tuple]: Tuple.Map[Ts, List] =
    macros.CollectTypesMacro.collectTypes[Ts](iterable)
}

// Example usage
val (circles, squares, triangles) = shapes.collectTypes[(Shape.Circle, Shape.Square, Shape.Polygon.Triangle)]
```

There's a minor inconvenience: we have to pass the type parameters as a `Tuple` (e.g., `collectTypes[(...)]`). But it allows us to handle N types just by adding two parentheses `()`.

### The Code the Macro Will Write

The main purpose of this macro is to have the compiler replace the `collectTypes` call. The new code is even more efficient than our manual `foldLeft` version. When the compiler sees `shapes.collectTypes[(...)]`, it generates the following code right in its place.

The process that I want is:

1. Create a `Builder` for each type.
2. Iterate through the collection **only once**. Use a `match` statement to add elements to the correct `Builder`.
3. Return a tuple containing the results from all `Builder`s.

```scala
// At compile time, the call is expanded into the following code:
{
  // 1. Create a Builder for each type
  val b1: scala.collection.mutable.Builder[Shape.Circle, List[Shape.Circle]] =
    scala.List.newBuilder[Shape.Circle]
  val b2: scala.collection.mutable.Builder[Shape.Square, List[Shape.Square]] =
    scala.List.newBuilder[Shape.Square]
  val b3: scala.collection.mutable.Builder[Shape.Polygon.Triangle, List[Shape.Polygon.Triangle]] =
    scala.List.newBuilder[Shape.Polygon.Triangle]

  // 2. Iterate once and use a match statement to add elements to the correct Builder
  shapes.foreach { item =>
    item match {
      case x: Shape.Circle           => b1.addOne(x)
      case x: Shape.Square           => b2.addOne(x)
      case x: Shape.Polygon.Triangle => b3.addOne(x)
      case _                         => ()
    }
  }

  // 3. Return a tuple of the results from all Builders
  (b1.result(), b2.result(), b3.result())
}
```

This generated code is exactly what I want. It is clean, efficient, and hidden behind a simple, reusable method call.

## Final Solution: A Macro with Compile-Time Safety

After getting this far, I noticed a critical flaw. Suppose I tried to filter for a type that has nothing to do with `Iterable[Shape]`, like `NotShape`. What would happen?

```scala
val (circles, notShapes) = shapes.collectTypes[(Shape.Circle, NotShape)]
```

The current macro doesn't check if the types passed to `collectTypes` are actually subtypes of the collection's element type (`Shape`). In this case, the code would compile successfully but would produce a bug at **runtime**. This is because the `NotShape` case in the `match` statement could never be reached. It would always return an empty list. **After all, catching issues at compile time is one of the main reasons for using macros.**

So, I added subtype validation logic to the macro. First, when calling the macro from `IterableOps`, we also pass the collection's element type `A`.

```scala
// IterableOps.scala
implicit class IterableOps[A](iterable: Iterable[A]) extends AnyVal {
  inline def collectTypes[Ts <: Tuple]: Tuple.Map[Ts, List] =
    // Pass type A to the macro for validation
    macros.CollectTypesMacro.collectTypes[A, Ts](iterable)
}
```

Then, the macro implementation (`collectTypesImpl`) receives this type information and performs the check.

```scala
// CollectTypesMacro.scala
def collectTypesImpl[A: Type, Ts <: Tuple: Type](...) = {
  // ...
  // --- Added validation logic ---
  val iterableElemTpe: TypeRepr = TypeRepr.of[A]
  types.foreach { t =>
    // Check the subtype relationship using the '<:<' operator
    if (!(t <:< iterableElemTpe)) {
      report.errorAndAbort(
        s"Type ${t.show} is not a subtype of the Iterable element type ${iterableElemTpe.show}"
      )
    }
  }
  // ------------------------------
  // ... rest of the macro implementation ...
}
```

Now, the macro knows about type `A`. At compile time, it confirms that every type passed in the `Tuple` is a subtype of `A`. If this is not true, we get a helpful compile error.

```bash
// When compiling code like shapes.collectTypes[(Shape.Circle, NotShape)]
[error] -- Error: .../Main.scala:39:35
[error] 39 |      shapes.collectTypes[(Shape.Circle, NotShape)]
...
[error]    |Type com.example.NotShape is not a subtype of the Iterable element type com.example.Shape.
```

This prevents runtime bugs at the source. It creates a truly robust and safe solution.

## Conclusion

- I started from a simple collection filtering problem and went through the following stages:
    1. **Problem Identification**: Multiple `collect` calls are inefficient.
    2. **First Improvement**: `foldLeft` is efficient but verbose and unintuitive.
    3. **Second Improvement**: `implicit class` is user-friendly, but it does not scale to N types.
    4. **Third Improvement**: A Scala macro can generate efficient code for N types. However, it lacked compile-time safety checks at first.
    5. **Final Solution**: I added subtype validation to the Scala 3 macro. This made it the ultimate solution, with **efficiency, type safety, and reusability**.
- Macros are more than just a tool for reducing code. They are a powerful way to build the exact abstractions you want without any runtime cost. I combined Scala's strong type system with macros. This let me solve complex requirements with code that is short, safe, and efficient.
