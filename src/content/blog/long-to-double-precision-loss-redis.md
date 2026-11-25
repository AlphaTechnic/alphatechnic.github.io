---
title: 'IEEE 754 Distorts My Ranking System'
description: 'Scores in our Redis ranking were slightly wrong. The cause was converting a 64-bit Long to a Double, which has only 53 bits of precision.'
pubDate: 2025-10-12
tags: ['floating-point number', 'IEEE754', 'precision', 'redis', 'Sorted Set']
---

## Intro

In this post, I want to describe in detail an interesting issue I had with our Redis-based ranking system.

![](../../assets/blogimages/long-to-double-precision-loss-redis/image-1.png)

One day, we noticed a problem on our game's leaderboard. The Battle Time records for some top-ranked players were shown as slightly distorted values. The user recorded a battle time of `600 seconds`, but the ranking leaderboard showed it as `600.06 seconds`. The client was clearly sending the correct value to the server, but the values shown to the user were wrong. I accessed the redis pod directly and queried the score. This confirmed that the battleTime based score had indeed been stored with slight distortion.

```bash
kubectl exec -it <redis-pod-name> -- redis-cli
```

```bash
ZSCORE <sorted-set-key> <player-id>
```

## Background: Our Scoring System

To make the issue clear, I first need to explain how our ranking system registers scores. Two criteria decide our game's dungeon ranking:

1. **Dealt Damage:** The higher, the better (Primary Key).
2. **Battle Time (in milliseconds):** The shorter, the better (Tie-Breaker).

If two users deal the same amount of damage, the user who cleared the dungeon in less time should rank higher. We wanted to implement this efficiently with a Redis Sorted Set. So we chose to combine these two values into a single score.

```scala
case class DungeonScore(dealtDamage: Long, battleTimeMillis: Int)
```

The most intuitive method was to concatenate `dealtDamage` and `battleTimeMillis` as if they were strings. A smaller `battleTimeMillis` is better. So we converted it to `(MAX_TIME - battleTimeMillis)` to reflect this in the score.

**Example:**

- `dealtDamage` = 100,000
- `MAX_TIME - battleTimeMillis` = 660,511 (assuming `MAX_TIME` is 999,000)
- **Final Score:** `100000660511` (concat both values above)

## Background: Long vs. Double

### Long vs. Double: Same 64 Bits, Different Worlds

Both `Long` and `Double` use 64 bits (8 bytes) of memory. But they interpret and represent data in completely different ways. To solve the problem, it is essential to understand this difference.

#### Long (64-Bit Integer)

A Long uses all 64 bits to directly represent the magnitude of an integer.

- **Structure:** All 64 bits are used to represent the number's value.
- **Precision:** Every integer within its representable range (`-2^63` to `2^63 - 1`) is stored with **100% accuracy**. There is no room for error, because each bit matches a specific place value.
- **Range:** Can represent integers from approximately `-9 * 10^18` to `9 * 10^18`.

#### Double (IEEE 754 64-Bit Floating-Point)

A Double follows the international **IEEE 754** standard. It divides its 64 bits into three parts and represents numbers in a way similar to scientific notation. This allows a very large range of real numbers, but precision is limited.

```scala
+------------+------------------------+-------------------------------------------+
|  Sign (1)  |      Exponent (11)     |          Mantissa / Fraction (52)         |
+------------+------------------------+-------------------------------------------+
|  [Bit 63]  |       [Bits 62-52]     |               [Bits 51-0]                 |
+------------+------------------------+-------------------------------------------+
```

- **Structure:**
    - **Sign bit (1 bit):** Shows if the number is positive or negative (0 for positive, 1 for negative).
    - **Exponent bits (11 bits):** Represents the number's magnitude (scale), written as a power of 2.
    - **Mantissa bits (52 bits):** Represents the significant digits (the precision) of the number. It effectively has 53 bits of precision because of an implicit leading bit.
- **Precision:** A `Double` stores its significant digits in only 53 bits (by adding the hidden leading bit to the 52 mantissa bits). Some large integers or complex fractions cannot be perfectly represented by these bits, so they are approximated. This leads to **Precision Loss**.
- **Range:** Can represent a very large range from approximately `±4.9 * 10^-324` to `±1.8 * 10^308` , but with finite precision. A `double` data type can represent numbers with 100% precision (without any rounding error) in the range from `-2^53` to `2^53`

### What Redis Requires: Long vs. Double

The official Redis ZADD command documentation([https://redis.io/docs/latest/commands/zadd/](https://redis.io/docs/latest/commands/zadd/)) says the following about the score value:

> "The score values should be the string representation of a double precision floating point number."

Our application was using a `Long` type for the combined score. But this means that the score was still converted to a `Double` in the end, when it was sent to Redis.

## Root Cause of the Value Distortion

The main cause of the problem is the limitation of the **Mantissa.** A `Double` can represent integers with perfect precision in the range from `−2^53` to `+2^53`. The value `2^53` is approximately `9,007,199,254,740,992` (or `9 * 10^15`).

The Redis documentation also explains this clearly ([https://redis.io/docs/latest/commands/zadd/#range-of-integer-scores-that-can-be-expressed-precisely](https://redis.io/docs/latest/commands/zadd/#range-of-integer-scores-that-can-be-expressed-precisely)):

> Redis sorted sets use a double 64-bit floating point number to represent the score. In all the architectures we support, this is represented as an IEEE 754 floating point number, that is able to represent precisely integer numbers between `-2^53` and `+2^53` included. In more practical terms, all the integers between -9007199254740992 and 9007199254740992 are perfectly representable. Larger integers, or fractions, are internally represented in exponential form, so it is possible that you get only an approximation of the decimal number, or of the very big integer, that you set as score.

With game updates, players' combat power increased. The `dealtDamage` values also grew significantly for game design purposes, to give users a greater sense of achievement.

**The Problem Scenario:**

- `dealtDamage` = 100,965,191,451
- `MAX_TIME - battleTimeMillis` = 9,660,511
- **Final Score to register in Redis:** `1009651914519660511`

The `battleTimeMillis` shown on the screen became distorted exactly when we handled this 19-digit number. The value shown was slightly different from what the user actually achieved. Let’s see the details.

Our 19-digit number, `1009651914519660511`, is far above the precision limit of a `Double` (`2^53`≈`9 * 10^15`)

Here is an estimate of the number of bits required, based on our top player's record:

- `dealtDamage` needs about **37 bits** (the top damage was 100,965,191,451, and `2^37` is approx. `1.3 * * 10^11`).
- `battleTimeMillis` needs about **24 bits** (the max time is 9,999,000ms, and `2^24` is approx. `1.6 * * 10^7`).

Combining them requires 37+24=61 bits. This is clearly more than the 53-bit precision limit of a `Double`'s mantissa. Therefore, the 19-digit number could not fit entirely into the 53-bit space. It was rounded to the nearest representable value, and this caused the precision loss.

- **Original `Long` value:** `1009651914519660511`
- **After `.toDouble` conversion:** `1009651914519660540`

You can easily check this with a simple line of code:

```scala
printf("%.0f\n", 1009651914519660511L.toDouble)
// Output: 1009651914519660540
```

You can clearly see that the last three digits, **511**, were changed to **540**. The server then decoded this changed value to calculate `battleTimeMillis`. As a result, the wrong time was shown to the user.

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

Fortunately, the distortion was small (from an intended 9,660,511ms to 9,660,540ms). The value was also only for a tie-breaker (`battleTimeMillis`). Therefore, it did not become a major issue for users.

## Brainstorming Solutions

Now that I understood the root cause, it was time to find a solution. I discussed various ideas with the team and analyzed the pros and cons of each.

### Idea 1: Persuade the Design Team (The Most Realistic Approach)

The first solution I thought of was to talk to the game designers. It was also the easiest and most realistic one.

- "Is such a large number for damage absolutely necessary?"
- "Would it be acceptable to record battle time in seconds instead of milliseconds?"

By talking with the design team, we could look for ways to reduce the number of bits needed for the combined score to below 53. This is the most direct way to solve the problem without the risk of system changes. But it's not the solution I want to focus on in this post.

### Idea 2: Other Technical Approaches

#### Storing Strings as Scores in Redis

- **Idea:** If Redis natively supported string scores, this would be the safest and most intuitive method. There would be no score size limitations.
- **Limitation:** Unfortunately, Redis Sorted Set scores only accept `Double` types. You cannot use a string directly as a score, and any workaround would be complex. Redis Sorted Sets do not even support `Long` as a score type and only allow `double`. So it is unrealistic to expect support for `String` scores. Even if `String` were supported, we would likely need to implement fairly complex decoding logic. This logic would interpret and compare the values properly.

#### Storing `battleTimeMillis` in a Separate Datastore

- **Idea:** Use `dealtDamage` as the primary score. Store `battleTimeMillis` in a separate Sorted Set or another datastore (e.g., Redis Hash, RDB) only for handling ties.
- **Limitation:** Maintaining a separate datastore just for tie-breaking increases system complexity and overhead. It would essentially require logic to bundle two datastores in a transaction. This can be very challenging in a distributed system. If we need to support one more tie-breaker, the system will become more complex.

### Idea 3: Particularly Interesting Ideas

#### Using Lexicographical Sorting

Redis Sorted Sets have a useful feature. If all scores are identical, the members are sorted in lexicographical (alphabetical) order. We can use this.

- **Method**
    1. Set the score for all users to a fixed value, like `0`.
    2. Create the actual score (e.g., `1009651914519660511`) as a string, combine it with the user ID, and store it as the member. **Zero-padding** the score string is essential. It makes sure all strings have the same length for correct sorting.

```scala
# Score is 0, member is "score:userID"
ZADD my_ranking 0 "1009651914519660511:user1234"
ZADD my_ranking 0 "0987654321098765432:user4567" # Zero-padding example

# Use ZREVRANGEBYLEX to get the ranking in reverse lexicographical order
ZREVRANGEBYLEX my_ranking [+ ( LIMIT 0 10
```

- **Pros:** There is no limit on the score size. This method uses Redis's native string sorting, which is highly efficient. So the rankings are accurate, and performance does not get worse. If all scores are identical, the `ZSET` effectively behaves like a lexicographically sorted set. Redis even provides commands such as `ZRANGEBYLEX` for this purpose. These commands can only be used when the scores are the same.
- **Cons:**
    - Since the score is fixed at `0`, you can't use commands that increment the score, like `ZINCRBY`. To update a score, you must delete the old member and add a new one.
    - You might need an additional mechanism to keep members unique during updates. One example is a Redis Hash that maps `userId` to the member string.
    - Above all, I am building production-grade software. This pattern does not follow best practices, and I am very hesitant to use Redis in such a way.

#### Bit-Level Transformation (Porting Long's Bit Pattern to Double)

The problem happens when `.toDouble` reinterprets a `Long`'s bit pattern. So what if we could just cast the type to `Double` and keep the `Long`'s bit pattern unchanged? We can do this with `java.lang.Double.longBitsToDouble` and `java.lang.Double.doubleToRawLongBits`.

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

This method has a powerful advantage. It can store a `Long` value as a `Double` and restore it perfectly, without any data loss. If `longA < longB`, then it is **highly likely** that the reinterpreted values will also satisfy `doubleA < doubleB`. Notice that I said **“highly likely,”** not “guaranteed.” You should remember one rule of **IEEE 754** floating-point representation. A value with all exponent bits set to 1 represents a special number:

- **Exponent bits all 1**
    - Fraction bits all 0 → represents `+-Infinity`
    - Fraction bits not 0 → represents `NaN`

Suppose that `longA < longB`, and we reinterpret them as `doubleA` and `doubleB`. In most cases, the order will still be the same (i.e., `doubleA < doubleB`). I understand that the probability of getting a value with all exponent bits set to 1 is extremely low. However, this approach has a clearly defined way to fail, even if the probability is small. I am very uncomfortable using it under the assumption that “it probably won’t happen.”

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

Also, the `Double` values themselves follow a highly non-linear pattern. In comparison, a `Long` increases linearly.

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

In the example above, the `Long` values differ by only 1. But the difference between the values converted with `longBitsToDouble` is extremely small, almost zero. Because of this, **rank-based queries** like "give me ranks 1 through 30" (`ZRANGE`) might work well. But **score-based range queries** like "give me users with scores between 100 and 300" (`ZRANGEBYSCORE`) are different. They will likely behave in unexpected ways or fail to give the results you want. But if your system does not use score-based range queries, this approach could be an effective solution. It could be worth considering. Of course, you could also handle this at the application level. There, you could reinterpret (`longBitsToDouble`) both `100` and `300` as doubles. Then you could query for scores within that reinterpreted double range.

## Conclusion

This issue with our Redis ranking system reminded me how important it is to understand the differences between basic numeric types like `Long` and `Double`. In particular, we need to know the precision limits of IEEE 754 floating-point numbers. Both types use 64 bits, but they represent data differently inside. These differences can cause unexpected data loss when handling large integers.

For now, we have handled the urgent problem. We talked with the design team to adjust the maximum `dealtDamage` value. This was the fastest and safest way to solve the problem without system changes.

However, new requirements could come at any time. They could bring even larger numbers, or a third sorting criterion besides `dealtDamage` and `battleTimeMillis`. If that happens, I plan to carefully evaluate the options again and apply the best solution. I will base it on the technical ideas above, such as **'Lexicographical Sorting'** or **'Porting Long's Bit Pattern to Double'**.

I hope this article helps other developers who have dealt with similar `Double` precision issues. I also hope it helps those who have had problems with large scores in Redis ranking systems. If you have other effective solutions or experiences, please share them in the comments.
