---
title: 'How CPython Handles Hash Collisions'
description: 'There are theoretical approaches to avoid collisions in hash maps:'
pubDate: 2022-04-21
tags: ['cpython', 'Hash Collision']
---

## Intro

There are theoretical approaches to avoid collisions in hash maps:

- **Separate chaining**
- **Open addressing**

Which approach does Python use internally? If you dig into CPython’s implementation, you can see it quite easily, and the comments explaining it are beautifully written.

## Explanation in CPython

- The explanatory comments written below are linked here [https://github.com/python/cpython/blob/2f1ecb3bc474a5895dce090cca7b8afe7b560040/Objects/dictobject.c#L291-L381](https://github.com/python/cpython/blob/2f1ecb3bc474a5895dce090cca7b8afe7b560040/Objects/dictobject.c#L291-L381).

```text
Major subtleties ahead:  Most hash schemes depend on having a "good" hash
function, in the sense of simulating randomness.  Python doesn't:  its most
important hash functions (for strings and ints) are very regular in common
cases:

  >>> map(hash, (0, 1, 2, 3))
  [0, 1, 2, 3]
  >>> map(hash, ("namea", "nameb", "namec", "named"))
  [-1658398457, -1658398460, -1658398459, -1658398462]
  >>>

This isn't necessarily bad!  To the contrary, in a table of size 2**i, taking
the low-order i bits as the initial table index is extremely fast, and there
are no collisions at all for dicts indexed by a contiguous range of ints.
The same is approximately true when keys are "consecutive" strings.  So this
gives better-than-random behavior in common cases, and that's very desirable.

OTOH, when collisions occur, the tendency to fill contiguous slices of the
hash table makes a good collision resolution strategy crucial.  Taking only
the last i bits of the hash code is also vulnerable:  for example, consider
the list [i << 16 for i in range(20000)] as a set of keys.  Since ints are
their own hash codes, and this fits in a dict of size 2**15, the last 15 bits
 of every hash code are all 0:  they *all* map to the same table index.

But catering to unusual cases should not slow the usual ones, so we just take
the last i bits anyway.  It's up to collision resolution to do the rest.  If
we *usually* find the key we're looking for on the first try (and, it turns
out, we usually do -- the table load factor is kept under 2/3, so the odds
are solidly in our favor), then it makes best sense to keep the initial index
computation dirt cheap.

The first half of collision resolution is to visit table indices via this
recurrence:

    j = ((5*j) + 1) mod 2**i

For any initial j in range(2**i), repeating that 2**i times generates each
int in range(2**i) exactly once (see any text on random-number generation for
proof).  By itself, this doesn't help much:  like linear probing (setting
j += 1, or j -= 1, on each loop trip), it scans the table entries in a fixed
order.  This would be bad, except that's not the only thing we do, and it's
actually *good* in the common cases where hash keys are consecutive.  In an
example that's really too small to make this entirely clear, for a table of
size 2**3 the order of indices is:

    0 -> 1 -> 6 -> 7 -> 4 -> 5 -> 2 -> 3 -> 0 [and here it's repeating]

If two things come in at index 5, the first place we look after is index 2,
not 6, so if another comes in at index 6 the collision at 5 didn't hurt it.
Linear probing is deadly in this case because there the fixed probe order
is the *same* as the order consecutive keys are likely to arrive.  But it's
extremely unlikely hash codes will follow a 5*j+1 recurrence by accident,
and certain that consecutive hash codes do not.

The other half of the strategy is to get the other bits of the hash code
into play.  This is done by initializing a (unsigned) vrbl "perturb" to the
full hash code, and changing the recurrence to:

    j = (5*j) + 1 + perturb;
    perturb >>= PERTURB_SHIFT;
    use j % 2**i as the next table index;

Now the probe sequence depends (eventually) on every bit in the hash code,
and the pseudo-scrambling property of recurring on 5*j+1 is more valuable,
because it quickly magnifies small differences in the bits that didn't affect
the initial index.  Note that because perturb is unsigned, if the recurrence
is executed often enough perturb eventually becomes and remains 0.  At that
point (very rarely reached) the recurrence is on (just) 5*j+1 again, and
that's certain to find an empty slot eventually (since it generates every int
in range(2**i), and we make sure there's always at least one empty slot).

Selecting a good value for PERTURB_SHIFT is a balancing act.  You want it
small so that the high bits of the hash code continue to affect the probe
sequence across iterations; but you want it large so that in really bad cases
the high-order hash bits have an effect on early iterations.  5 was "the
best" in minimizing total collisions across experiments Tim Peters ran (on
both normal and pathological cases), but 4 and 6 weren't significantly worse.

Historical: Reimer Behrends contributed the idea of using a polynomial-based
approach, using repeated multiplication by x in GF(2**n) where an irreducible
polynomial for each table size was chosen such that x was a primitive root.
Christian Tismer later extended that to use division by x instead, as an
efficient way to get the high bits of the hash code into play.  This scheme
also gave excellent collision statistics, but was more expensive:  two
if-tests were required inside the loop; computing "the next" index took about
the same number of operations but without as much potential parallelism
(e.g., computing 5*j can go on at the same time as computing 1+perturb in the
above, and then shifting perturb can be done while the table index is being
masked); and the PyDictObject struct required a member to hold the table's
polynomial.  In Tim's experiments the current scheme ran faster, produced
equally good collision statistics, needed less code & used less memory.
```

## Big Concepts

- Python’s `dict` resolves hash collisions using an **open addressing** scheme.
- The Python hash table is stored as a **contiguous block of memory** (like an array).
- To handle collisions, it uses a “perturbation” strategy to vary the probe indices.
- Each slot in the table can hold **exactly one item**.

## Initialization and Insertion

```c
#define PyDict_MINSIZE 8
```

When a new dict is initialized, it starts with 8 slots. (Defined in `Include/dictobject.h`)

> **“Most important hash functions (for strings and ints) are very regular in common cases.”**

Two key qualities of a good hash function are likely the following:

1. **Fast computation**
2. **Minimizing collisions**

This is what the CPython comments refer to when they mention using a **very regular** hash function. The “very regular” rule refers to `taking the low-order i bits` as the initial table index. This approach is described as **extremely fast**.

## Collision

```text
j = ((5*j) + 1) mod 2**i;
```

- How are collisions handled? Python updates the probe index using the recurrence:
    - This formula is proven to visit every slot exactly once before repeating.
    - The multiplier `5` was chosen because Tim Peters found it minimized total collisions across both normal and pathological cases (although `4` and `6` performed similarly).

```text
j = (5*j) + 1 + perturb;
perturb >>= PERTURB_SHIFT;
use j % 2**i as the next table index;
```

- On top of that, Python adds a “`perturb`” value drawn from the full hash code
    - The `PERTURB_SHIFT` constant balances how quickly high-order bits of the hash influence the sequence.
    - Over iterations, `perturb` shifts right until it becomes zero, at which point the probe follows just `5*j+1`.
    - Since one empty slot is guaranteed, this sequence will eventually find it.

## Slot Index Lookup

```c
static inline Py_ALWAYS_INLINE Py_ssize_t
do_lookup(PyDictObject *mp, PyDictKeysObject *dk, PyObject *key, Py_hash_t hash,
          int (*check_lookup)(PyDictObject *, PyDictKeysObject *, void *, Py_ssize_t ix, PyObject *key, Py_hash_t))
{
    void *ep0 = _DK_ENTRIES(dk);
    size_t mask = DK_MASK(dk);
    size_t perturb = hash;
    size_t i = (size_t)hash & mask;
    Py_ssize_t ix;
    for (;;) {
        ix = dictkeys_get_index(dk, i);
        if (ix >= 0) {
            int cmp = check_lookup(mp, dk, ep0, ix, key, hash);
            if (cmp < 0) {
                return cmp;
            } else if (cmp) {
                return ix;
            }
        }
        else if (ix == DKIX_EMPTY) {
            return DKIX_EMPTY;
        }
        perturb >>= PERTURB_SHIFT;
        i = mask & (i*5 + perturb + 1);

        // Manual loop unrolling
        ix = dictkeys_get_index(dk, i);
        if (ix >= 0) {
            int cmp = check_lookup(mp, dk, ep0, ix, key, hash);
            if (cmp < 0) {
                return cmp;
            } else if (cmp) {
                return ix;
            }
        }
        else if (ix == DKIX_EMPTY) {
            return DKIX_EMPTY;
        }
        perturb >>= PERTURB_SHIFT;
        i = mask & (i*5 + perturb + 1);
    }
    Py_UNREACHABLE();
}
```

**Initialization:**

- `i = hash & mask` – Compute the initial index using the lower bits of the hash.
- `perturb = hash` – Initialize `perturb` with the full hash value.

**Infinite loop (`for (;;)`):**

- `ix = dictkeys_get_index(dk, i)` – Retrieve the index at the current position.
- If `ix >= 0`, an entry exists; compare the key using the `check_lookup` callback.
- If `ix == DKIX_EMPTY`, return that the key is not found.
- `perturb >>= PERTURB_SHIFT` – Right-shift the `perturb` value.
- `i = mask & (i*5 + perturb + 1)` – Compute the next index (recurrence relation).

**Manual loop unrolling:**

- Repeat the loop body twice for performance optimization.

## Finding Empty Slots

```c
static inline int
is_unusable_slot(Py_ssize_t ix)
{
#ifdef Py_GIL_DISABLED
    return ix >= 0 || ix == DKIX_DUMMY;
#else
    return ix >= 0;
#endif
}

/* Internal function to find slot for an item from its hash
   when it is known that the key is not present in the dict.
 */
static Py_ssize_t
find_empty_slot(PyDictKeysObject *keys, Py_hash_t hash)
{
    assert(keys != NULL);

    const size_t mask = DK_MASK(keys);
    size_t i = hash & mask;
    Py_ssize_t ix = dictkeys_get_index(keys, i);
    for (size_t perturb = hash; is_unusable_slot(ix);) {
        perturb >>= PERTURB_SHIFT;
        i = (i*5 + perturb + 1) & mask;
        ix = dictkeys_get_index(keys, i);
    }
    return i;
}
```

Here is the routine that finds an empty slot when inserting a new key. Since `perturb` is deterministic rather than random, we can apply the similar logic used for finding an empty slot and lookup as well.
