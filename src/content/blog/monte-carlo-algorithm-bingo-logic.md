---
title: 'Trading 100% Certainty for 99.99% Efficiency'
description: 'I''d like to share my experience applying the Monte Carlo algorithm to solve a problem I encountered in my work. It was a fascinating journey that showed how...'
pubDate: 2025-10-26
tags: ['Miller-Rabin', 'monte carlo', 'non-deterministic', 'probablistic']
---

## Intro

I'd like to share how I used the **Monte Carlo algorithm** to solve a problem I faced in my work. It was a very interesting experience. It showed how efficiently a problem that seems complex can be solved by changing your point of view a little.

## The Problem I Faced: Finding a 'Non-Bingo' Combination

### Game Rules

![](../../assets/blogimages/monte-carlo-algorithm-bingo-logic/image-1.png)

Our game has a system where players get rewards from an N x N bingo board. The rules are simple:

1. Each cell on the N x N bingo board contains a possible reward for the user.
2. When the user presses a button, the system rolls a dice. The result is either a 'Bingo' or a 'Losing Hand'.
    1. If it's a **'Bingo'**, the system randomly selects N or more cells that include at least one bingo line. It then gives out the rewards. The user also gets an extra bonus for getting a bingo.
    2. If it's a **'Losing Hand'**, the system selects N or more cells that do not form any bingo lines. It then gives out the rewards.

Creating a 'Bingo' combination is fairly simple. We can pre-calculate all possible horizontal, vertical, and diagonal bingo combinations on the N x N board and store them. When needed, we can pick one of these pre-calculated sets to guarantee at least one bingo. Any extra cells we need can be selected randomly. This whole process can be solved within polynomial time.

```scala
// Pre-calculate all bingo combinations and store them in board.bingos.
val allBingos: List[Set[Int]] = {
  val rowBingos: List[Set[Int]]    =
    (0 until rowCount).map(row => (0 until columnCount).map(col => row * columnCount + col).toSet).toList
  val columnBingos: List[Set[Int]] =
    (0 until columnCount).map(col => (0 until rowCount).map(row => row * columnCount + col).toSet).toList
  val diagBingos: List[Set[Int]]   =
    if (rowCount == columnCount) {
      val size        = rowCount
      val leftToRight = (0 until size).map(i => i * (size + 1)).toSet
      val rightToLeft = (0 until size).map(i => (i + 1) * (size - 1)).toSet
      List(leftToRight, rightToLeft)
    } else Nil

  (rowBingos ++ columnBingos ++ diagBingos).map(_.toSet)
}
```

However, the problem was how to generate a 'Losing Hand'. This is a combination with **no bingos**. How could we do this?

### First Attempt: Calculating All Possible 'Losing Hand' Cases

The most obvious method was to pre-calculate every possible 'non-bingo' combination. Then we could simply pick one at random upon request.

- **Advantage:** The response time in a live environment would be extremely fast. This is because the system only needs to select from a pre-calculated list.
- **Disadvantage:** The number of combinations is huge. Even for a simple 5x5 board, it is extremely expensive to calculate and store every non-bingo combination of N or more cells. What if a game designer asks, "How about a 10x10 bingo board?" or "Could you add cases where we reward N+1, N+2, ... cells?" If we pre-calculate all cases, we can only support very small boards.

I concluded that with a **deterministic** method, it would be difficult to ensure scalability and flexibility.

### Second Attempt: The Monte Carlo Algorithm

This is where probabilistic algorithms, specifically the **Monte Carlo algorithm**, were a great solution.

Let's briefly talk about NP problems. In an NP problem, it is difficult to find a solution. But once you have a possible solution, you can quickly check if it is correct. My problem of finding a 'non-bingo combination' fits this description. It's hard to generate all valid combinations. But if you have a specific combination, checking "Is this a bingo?" is very fast.

```scala
// A function to check if the selected cells (selectedIndexes) contain a bingo.
def containsBingo(selectedIndexes: Set[Int]): Boolean =
  allBingos.exists(_.subsetOf(selectedIndexes))
```

The Monte Carlo algorithm uses exactly this point. The main idea is: **"Let's not try to find the correct answer in one try. Instead, let's make random guesses, check them quickly, and repeat the process multiple times."**

## How the Monte Carlo Algorithm Works

1. **Describe the problem** as a **"decision problem"** (a question with a Yes/No answer).
2. **Randomly select** a candidate to check (Sampling).
3. **Perform a quick test** (in polynomial time).
    - **Yes:** We found an answer! Stop the algorithm immediately.
    - **Not determined yet:** We don't know yet. We haven't found the answer. We also can't be certain that it can't be found. Go back to step 2 and pick another candidate.
4. The number of attempts is set in advance. If the result is always 'Not determined yet' after these attempts, the algorithm finally concludes **"No"** (an answer was not found).

The algorithm can wrongly return 'No' when the true answer is 'Yes'. The key is that the probability of this decreases exponentially as the number of trials (n) increases. The failure rate is `(probability of failure in one trial)^n`.

Of course, there is still a small probability of failure. So, the most important question to ask before you apply this algorithm is:

> "Can our business tolerate the risk of a low-probability failure?"

You would never use this for a missile launch or a life-critical system. But what about our game? If the system fails to find a 'non-bingo' combination, the user sees a temporary error pop-up. The user simply has to press the button again. This level of risk is perfectly acceptable.

## Applying the Monte Carlo Algorithm to the Game

### Process

Now, let's describe our problem in a way that fits the Monte Carlo algorithm.

- **Decision Problem:** "Is a randomly selected combination of N cells a 'non-bingo' combination?"
- **Algorithm Steps:**
    1. Randomly pick N cells from the N x N board.
    2. Check if this combination contains a bingo (using the `containsBingo` function).
        - **It does not contain a bingo (Yes):** We found the answer! Give this combination to the user and stop immediately.
        - **It contains a bingo (Not determined yet):** We haven't found an answer yet. Go back to step 1 and pick another combination.
    3. If we find only bingo combinations after a set number of attempts (e.g., 300), finally conclude "Failed to find" and send an error to the user.

Below is a part of the actual implementation. The `pickNonBingoCells` function is the core of our Monte Carlo algorithm.

```scala
// Logic to select a 'Bingo' combination
lazy val pickBingoCells: KingdomReader[Set[Int]] =
  for {
    // ... choose one of the bingo combinations, add more cells if needed ...
  } yield pickedBingo ++ additionalCells.toSet

// Logic to select a 'Losing Hand' (non-bingo) combination (Monte Carlo Algorithm)
lazy val pickNonBingoCells: KingdomReader[Set[Int]] = {
  def recursive(trial: Int): KingdomReader[Set[Int]] =
    for {
      // 1. Check if the trial count exceeds the max attempts (300)
      ()                  <- assertThat(
                               trial < 300,
                               ValidationError.Unexpected(s"Fail to draw a non-bingo indexes with 300 trials.")
                             )
      // 2. Randomly pick N cells (Sampling)
      randomlyPickedCells <- chooseWeightedN(
                               extData.board.cells.toList,
                               extData.bingoSetCount,
                               // ...
                             ).map(_.map(_.index).toSet)
      // 3. Check if it contains a bingo (Quick Verification)
      nonBingoCells       <- if (extData.containsBingo(randomlyPickedCells))
                               // 3-1. If it contains a bingo? Retry with a recursive call (Not determined yet)
                               recursive(trial + 1)
                             else
                               // 3-2. If it's not a bingo? Success! Return the result (Yes)
                               pure(randomlyPickedCells)
    } yield nonBingoCells

  recursive(0) // Start with the 0th trial
}

// Finally, decide between the bingo/non-bingo logic based on a dice roll probability
lazy val pickRandomCells: KingdomReader[Set[Int]] =
    ifM(dice(bingoRate))(pickBingoCells, pickNonBingoCells)
```

### Is It Really Safe?

What's the probability of failure if we set the maximum number of trials to 300?

Let's assume an extreme case where the number of cells to select is close to N x N. This makes the probability of getting a 'Losing Hand' only 1%. In other words, there is a 99% chance of randomly picking a bingo. The probability of picking a bingo combination 300 times in a row is:

`(0.99)^300 ≈ 0.049`

That's about 4.9%, which is still hard to ignore. But suppose the probability of a 'Losing Hand' is just 5% (a 95% chance of bingo). Then the failure rate becomes:

`(0.95)^300 ≈ 0.000000155`

The probability gets very close to zero. Our game has a very large number of users, so even this tiny number might not be 100% reassuring. However, we can add a static validation step during the planning phase. This step ensures that the probability of a 'non-bingo' combination stays above a certain threshold. With this step, the method becomes a solution that is stable and efficient enough.

## Another Example: Primality Testing and RSA Encryption

The Monte Carlo algorithm is widely used in critical technologies around us. A very good example is the **primality test** used in **RSA encryption**.

RSA encryption works by multiplying two very large prime numbers, `p1` and `p2`, to create an encryption key. Multiplying the two primes happens instantly. But with current technology, it is computationally infeasible to factor the product (`p1` \* `p2`) and find the original `p1` and `p2`.

So, how can we quickly and accurately check if a huge number with hundreds of digits is a prime number? We use the Monte Carlo method, based on an algorithm called the **Miller-Rabin Primality Test**.

### Miller-Rabin Primality Test

The Miller-Rabin test is a probabilistic algorithm. It determines whether a given number is likely to be prime. It's based on an extension of Fermat's Little Theorem. It is widely used in fields like cryptography (e.g., RSA) because it works very quickly even for extremely large numbers.

The method tries to find definite proof that a number is **composite** (not prime). If multiple tests find no such proof, the number is declared to be "probably prime."

- **Decision Problem:** "Is the number N a 'composite' number?"
- **The Test:** It checks if the number meets certain conditions. (The probability that a single test fails to identify a composite number is approximately `1/4`.)
    - **Yes (fails the test):** We have found 100% certain proof that the number is **composite**.
    - **Not determined yet:** We don't know if it's composite or prime. It has a chance of being prime (strong pseudoprime).
- **Result:** Suppose the outcome is always 'Not determined yet' after multiple tests. Then the number N is considered to have a very high probability of being prime. It is treated as prime.

So, if we repeat the test 10 times, the probability of wrongly identifying a composite number as a prime number drops to:

`(1/4)^10 ≈ ****0.00000095`

This means we can be over 99.9999% certain that the number is prime. It's not a perfect 100%. But it is considered reliable enough to secure cryptographic systems.

## Conclusion

The Monte Carlo algorithm is a powerful tool. It gives a **"probabilistic answer that is reliable enough"** in a short time, instead of a "100% certain answer." Trying to solve every problem deterministically by examining all possible cases is extremely costly and inefficient. When you consider this, the probabilistic approach can be an incredibly useful tool for a developer.

Of course, you need to think carefully about the "acceptable risk" involved. But this experience taught me that sometimes you can find more elegant and practical solutions. You do this by no longer being obsessed with perfection and by accepting a reasonable level of uncertainty.
