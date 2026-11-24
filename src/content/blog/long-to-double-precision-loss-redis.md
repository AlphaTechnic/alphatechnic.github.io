---
title: 'IEEE 754 Distorts My Ranking System'
description: 'In this post, I want to share a detailed account of an interesting issue I encountered with our Redis-based ranking system.'
pubDate: 2025-10-12
tags: ['floating-point number', 'IEEE754', 'precision', 'redis', 'Sorted Set']
---

## Intro

In this post, I want to share a detailed account of an interesting issue I encountered with our Redis-based ranking system.

![](../../assets/blogimages/long-to-double-precision-loss-redis/image-1.png)

One day, we noticed that the Battle Time records for some top-ranked players on our game's leaderboard were being displayed as slightly distorted values. The user recorded a battle time of `600 seconds`, but it was displayed as `600.06 seconds` on the ranking leaderboard. Even though the client was clearly sending the correct value to the server, the values shown to the user were incorrect. When I directly accessed the redis pod and queried the score, I confirmed that the battleTime based score had indeed been stored with slight distortion.

```bash
kubectl exec -it <redis-pod-name> -- redis-cli
```

```bash
ZSCORE <sorted-set-key> <player-id>
```

## Background: Our Scoring System

To clearly understand the issue, I first need to explain how our ranking system registers scores. Our game's dungeon ranking is determined by two criteria:

1. **Dealt Damage:** The higher, the better (Primary Key).
2. **Battle Time (in milliseconds):** The shorter, the better (Tie-Breaker).

If two users inflict the same amount of damage, the user who cleared the dungeon in less time should rank higher. To implement this efficiently with a Redis Sorted Set, we chose to combine these two values into a single score.

```scala
case class DungeonScore(dealtDamage: Long, battleTimeMillis: Int)
```

The most intuitive method was to concatenate `dealtDamage` and `battleTimeMillis` as if they were strings. Since a smaller `battleTimeMillis` is better, we converted it to `(MAX_TIME - battleTimeMillis)` to reflect this in the score.

**Example:**

- `dealtDamage` = 100,000
- `MAX_TIME - battleTimeMillis` = 660,511 (assuming `MAX_TIME` is 999,000)
- **Final Score:** `100000660511` (concat both values above)

## Background: Long vs Double

### Long vs. Double: Same 64 Bits, Different Worlds

Both `Long` and `Double` use 64 bits (8 bytes) of memory, but they interpret and represent data in completely different ways. Understanding this difference is fundamental to solving the problem.

#### 1\. Long (64-bit Integer)

A Long uses all 64 bits to directly represent the magnitude of an integer.

- **Structure:** All 64 bits are used to represent the number's value.
- **Precision:** Every integer within its representable range (`-2^63` to `2^63 - 1`) is stored with **100% accuracy**. There is no room for error, as each bit corresponds to a specific place value.
- **Range:** Can represent integers from approximately `-9 * 10^18` to `9 * 10^18`.

#### 2\. Double (IEEE 754 64-bit Floating-Point)

A Double follows the international **IEEE 754** standard, dividing its 64 bits into three parts to represent numbers in a way similar to scientific notation. This allows for a vast range of real numbers but comes with limitations in precision.

```scala
+------------+------------------------+-------------------------------------------+
|  Sign (1)  |      Exponent (11)     |          Mantissa / Fraction (52)         |
+------------+------------------------+-------------------------------------------+
|  [Bit 63]  |       [Bits 62-52]     |               [Bits 51-0]                 |
+------------+------------------------+-------------------------------------------+
```

- **Structure:**
    - **Sign bit (1 bit):** Determines if the number is positive or negative (0 for positive, 1 for negative).
    - **Exponent bits (11 bits):** Represents the number's magnitude (scale), expressed as a power of 2.
    - **Mantissa bits (52 bits):** Represents the significant digits (the precision) of the number. It effectively has 53 bits of precision due to an implicit leading bit.
- **Precision:** Because a `Double` stores its significant digits in only 53 bits (by adding the hidden leading bit to the 52 mantissa bits), large integers or complex fractions that cannot be perfectly represented by these bits are approximated. This leads to **Precision Loss**.
- **Range:** Can represent an enormous range from approximately `±4.9 * 10^-324` to `±1.8 * 10^308` , but with finite precision. The range of numbers that a `double` data type can represent with 100% precision (without any rounding error) is from `-2^53` to `2^53`

### ⭐️ What Redis requires: Long vs Double

The official Redis ZADD command documentation([https://redis.io/docs/latest/commands/zadd/](https://redis.io/docs/latest/commands/zadd/)) states the following about the score value:

> "The score values should be the string representation of a double precision floating point number."

This means that even though our application was using a `Long` type for the combined score, it was ultimately being converted to a `Double` when sent to Redis.

## Root cause of the value distortion

The core of the problem lies in the limitation of the **Mantissa.** The range of integers that a `Double` can represent with perfect precision is from `−2^53` to `+2^53`. The value `2^53` is approximately `9,007,199,254,740,992` (or `9 * 10^15`).

The Redis documentation also points this out clearly ([https://redis.io/docs/latest/commands/zadd/#range-of-integer-scores-that-can-be-expressed-precisely](https://redis.io/docs/latest/commands/zadd/#range-of-integer-scores-that-can-be-expressed-precisely)):

> Redis sorted sets use a double 64-bit floating point number to represent the score. In all the architectures we support, this is represented as an IEEE 754 floating point number, that is able to represent precisely integer numbers between `-2^53` and `+2^53` included. In more practical terms, all the integers between -9007199254740992 and 9007199254740992 are perfectly representable. Larger integers, or fractions, are internally represented in exponential form, so it is possible that you get only an approximation of the decimal number, or of the very big integer, that you set as score.

With game updates, players' combat power increased, and for game designing purposes—to give users a greater sense of achievement—the `dealtDamage` values grew significantly.

**The Problem Scenario:**

- `dealtDamage` = 100,965,191,451
- `MAX_TIME - battleTimeMillis` = 9,660,511
- **Final Score to register in Redis:** `1009651914519660511`

It was precisely when handling this 19-digit number that the `battleTimeMillis` displayed on the screen became distorted, showing a value slightly different from what the user actually achieved. Let’s see the details.

Our 19-digit number, `1009651914519660511`, vastly exceeds the precision limit of a `Double` (`2^53`≈`9 * 10^15`)

Estimating the number of bits required based on our top player's record:

- `dealtDamage` needs about **37 bits** (the top damage was 100,965,191,451, and `2^37` is approx. `1.3 * * 10^11`).
- `battleTimeMillis` needs about **24 bits** (the max time is 9,999,000ms, and `2^24` is approx. `1.6 * * 10^7`).

Combining them requires 37+24=61 bits, which clearly exceeds the 53-bit precision limit of a `Double`'s mantissa. Therefore, the 19-digit number could not fit entirely into the 53-bit space and was rounded to the nearest representable value, causing the precision loss.

- **Original `Long` value:** `1009651914519660511`
- **After `.toDouble` conversion:** `1009651914519660540`

This can be easily verified with a simple line of code:

```scala
printf("%.0f\n", 1009651914519660511L.toDouble)
// Output: 1009651914519660540
```

You can clearly see that the last three digits, **511**, were changed to **540**. The server then decoded this modified value to calculate `battleTimeMillis`, resulting in the wrong time being displayed to the user.

```text
+--------------------------------------------------------------------+
| DungeonScore(dealtDamage=100965191451L, battleTimeMillis=9660511L) |
+--------------------------------------------------------------------+
                         |
                         | (Combine into a single Long)
                         V
+--------------------------------------------------------------------+
|                       1009651914519660511L                         |
+--------------------------------------------------------------------+
                         |
                         | (Enroll to Redis -> .toDouble conversion)
                         | (Precision loss occurs here)
                         V
+--------------------------------------------------------------------+
|                       1009651914519660540.0                        |
+--------------------------------------------------------------------+
                         |
                         | (Decode the value back from Redis)
                         V
+--------------------------------------------------------------------+
| DungeonScore(dealtDamage=100965191451L, battleTimeMillis=9660540L) |
+--------------------------------------------------------------------+
```

Therefore, fortunately the distortion was small (from an intended 9,660,511ms to 9,660,540ms) and the value was only for a tie-breaker (`battleTimeMillis`), so it didn't escalate into a major user-facing issue.

## Brainstorming Solutions

Now that I understood the root cause, it was time to find a solution. I discussed various ideas with the team and analyzed the pros and cons of each.

### Idea 1: Persuade the Design Team (The Most Realistic Approach)

The first, easiest, and most realistic solution that came to mind was to talk to the game designers.

- "Is such a large number for damage absolutely necessary?"
- "Would it be acceptable to record battle time in seconds instead of milliseconds?"

By communicating with the design team, we could explore ways to reduce the number of bits needed for the combined score to below 53. This is the most direct way to solve the problem without the risk of system changes, but it's not the solution I want to focus on in this post.

### Idea 2: Other Technical Approaches

#### 1\. Storing Strings as Scores in Redis

- **Idea:** If Redis natively supported string scores, this would be the safest and most intuitive method, with no score size limitations.
- **Limitation:** Unfortunately, Redis Sorted Set scores only accept `Double` types. Using a string directly as a score is not possible, and any workaround would be complex. Since Redis Sorted Sets do not even support `Long` as a score type and only allow `double`, it is unrealistic to expect support for `String` scores. Even if `String` were supported, we would likely need to implement a fairly complex decoding logic to interpret and compare the values properly.

#### 2\. Storing `battleTimeMillis` in a Separate Datastore

- **Idea:** Use `dealtDamage` as the primary score and store `battleTimeMillis` in a separate Sorted Set or another datastore (e.g., Redis Hash, RDB) only for handling ties.
- **Limitation:** Maintaining a separate datastore just for tie-breaking increases system complexity and overhead. It would essentially require logic to bundle two datastores in a transaction, which can be very challenging in a distributed system. If one more tie-breaker needs to be supported, the system will become more complex.

### Idea 3: Particularly Interesting Ideas

#### 1\. Leveraging Lexicographical Sorting

Redis Sorted Sets have a feature where if all scores are identical, the members are sorted in lexicographical (alphabetical) order. We can leverage this.

- **Method**
    1. Set the score for all users to a fixed value, like `0`.
    2. Create the actual score (e.g., `1009651914519660511`) as a string, combine it with the user ID, and store it as the member. **Zero-padding** the score string is essential to ensure all strings have the same length for correct sorting.

```scala
# Score is 0, member is "score:userID"
ZADD my_ranking 0 "1009651914519660511:user1234"
ZADD my_ranking 0 "0987654321098765432:user4567" # Zero-padding example

# Use ZREVRANGEBYLEX to get the ranking in reverse lexicographical order
ZREVRANGEBYLEX my_ranking [+ ( LIMIT 0 10
```

- **Pros:** There's no limit on the score size, and it uses Redis's native, highly efficient string sorting, ensuring accurate rankings without performance degradation. If all scores are identical, the `ZSET` effectively behaves like a lexicographically sorted set. Redis even provides commands such as `ZRANGEBYLEX` for this purpose (which can only be used when the scores are the same).
- **Cons:**
    - Since the score is fixed at `0`, you can't use score-incrementing commands like `ZINCRBY`. Score updates must be implemented by deleting the old member and adding a new one.
    - You might need an additional mechanism (e.g., a Redis Hash mapping `userId` to the member string) to manage member uniqueness during updates.
    - Above all, I am building production-grade software, and I am very hesitant to use Redis in a way that deviates from best practices, as in this pattern.

#### 2\. Bit-level Transformation (Porting Long's Bit Pattern to Double)

Since the problem arises when `.toDouble` reinterprets a `Long`'s bit pattern, what if we could just cast the type to `Double` while keeping the `Long`'s bit pattern intact? This can be done using `java.lang.Double.longBitsToDouble` and `java.lang.Double.doubleToRawLongBits`.

```scala
// Convert Long to Double, preserving the bit pattern
val originalLong: Long = 1009651914519660511L
val encodedDouble: Double = java.lang.Double.longBitsToDouble(originalLong)

// Restore the bit pattern from the Double back to a Long
val decodedLong: Long = java.lang.Double.doubleToRawLongBits(encodedDouble)

println(s"Original Long: $originalLong") // Original Long: 1009651914519660511
println(s"Encoded Double (actual representation): $encodedDouble") // Encoded Double (actual representation): 3.562561189018053E-241
println(s"Decoded Long: $decodedLong") // Decoded Long: 1009651914519660511
// decodedLong is exactly identical to originalLong!
```

This method has the powerful advantage of storing a `Long` value as a `Double` and restoring it perfectly without any data loss. If `longA < longB`, then it is **highly likely** that the reinterpreted values will also satisfy `doubleA < doubleB`. Notice that I said **“highly likely,”** not “guaranteed.” You should remember that in **IEEE 754** floating-point representation, a value with all exponent bits set to 1 represents a special number:

- **Exponent bits all 1**
    - Fraction bits all 0 → represents `+-Infinity`
    - Fraction bits not 0 → represents `NaN`

When `longA < longB`, and we reinterpret them as `doubleA` and `doubleB`, the ordering will, in most cases, still be preserved (i.e., `doubleA < doubleB`). I understand that the probability of encountering a value with all exponent bits set to 1 is extremely low. Nevertheless, I am very uncomfortable adopting an approach that has a clearly defined failure path—even if the probability is small—under the assumption that “it probably won’t happen.”

```scala
// NaN bit pattern (exponent all 1, fraction non-zero)
val longA: Long = 0x7FF8000000000001L  // NaN
val longB: Long = 1009651914519660511L // Normal value

val doubleA: Double = java.lang.Double.longBitsToDouble(longA)
val doubleB: Double = java.lang.Double.longBitsToDouble(longB)

println(s"longA < longB: ${longA < longB}")

println(s"doubleA value: $doubleA")
println(s"doubleB value: $doubleB")

println(s"doubleA < doubleB: ${doubleA < doubleB}")
println(s"doubleA > doubleB: ${doubleA > doubleB}")
println(s"doubleA == doubleB: ${doubleA == doubleB}")

println(s"Double.compare(doubleA, doubleB): ${java.lang.Double.compare(doubleA, doubleB)}") // In the JVM, NaN is considered greater than all other numeric values.
```

```scala
longA < longB: false
doubleA value: NaN
doubleB value: 3.562561189018053E-241
doubleA < doubleB: false
doubleA > doubleB: false
doubleA == doubleB: false
Double.compare(doubleA, doubleB): 1
```

Moreover, the `Double` values themselves follow a highly non-linear pattern compared to the linear increase of a `Long`.

```scala
val longA: Long = 0x3FFFFFFFFFFFFFFFL // 2^62 - 1 (a boundary value)
val longB: Long = 0x4000000000000000L // 2^62

println(s"Difference in Longs: ${longB - longA}") // Difference in Longs: 1

val doubleA = java.lang.Double.longBitsToDouble(longA)
val doubleB = java.lang.Double.longBitsToDouble(longB)
println(s"Double value A: $doubleA") // Double value A: 1.9999999999999998
println(s"Double value B: $doubleB") // Double value B: 2.0
println(s"Difference in Doubles: ${doubleB - doubleA}") // Difference in Doubles: 2.220446049250313E-16
```

In the example above, the `Long` values differ by only 1, but the difference between the `longBitsToDouble` converted values is infinitesimally small, almost zero. Because of this, **rank-based queries** like "give me ranks 1 through 30" (`ZRANGE`) might work well, but **score-based range queries** like "give me users with scores between 100 and 300" (`ZRANGEBYSCORE`) will likely behave unexpectedly or fail to produce the desired results. But if your system does not use score-based range queries, this approach could be a effective solution worth considering. Of course, at the application level, one could reinterpret (`longBitsToDouble`) both `100` and `300` as doubles and then query for scores within that reinterpreted double range.

## Conclusion

This issue with our Redis ranking system was a stark reminder of how crucial a fundamental understanding of the differences between basic numeric types like `Long` and `Double`—specifically the precision limits of IEEE 754 floating-point numbers—can be. Although they both use 64 bits, their internal data representation differences can cause unexpected data loss when handling large integers.

For now, we've put out the immediate fire by communicating with the design team to adjust the maximum `dealtDamage` value. This was the fastest and safest way to resolve the problem without system changes.

However, new requirements could at any time introduce even larger numbers or a third sorting criterion besides `dealtDamage` and `battleTimeMillis`. If that happens, I plan to carefully re-evaluate and apply the optimal solution based on the technical ideas presented above, such as **'Lexicographical Sorting'** or **'Porting Long's Bit Pattern to Double'**.

I hope this article is helpful to other developers who have dealt with similar `Double` precision issues or challenges with large scores in Redis ranking systems. If you have other effective solutions or experiences, please share them in the comments.
