---
title: 'Keeping Backward Compatibility While Changing the Reward Structure'
description: 'Each reward type expressed conversions in its own way. I changed them into one structure. I also describe the methods I used to avoid breaking old data under event sourcing.'
pubDate: 2026-11-27
tags: ['backward compatibility', 'event sourcing', 'protobuf', 'scala']
---

## Intro

In our game, rewards are more complex than they look. A reward the user was meant to get often does not arrive as is. It turns into a different reward instead. For example, when a user gets a new character as a reward, the following can happen.

1. If the user already has the character, it turns into that character's **stones**.
2. If the stones are full, it turns into **super stones**.
3. If even the super stones are full, it turns into a **substitute reward**.

A single reward can hide several steps of conversion like this. But the way we expressed these conversions was different for each reward type. So it was hard to tell from a Reward alone what the user was meant to get and what it turned into.

I felt strongly that this structure was a problem, so I spent eight weeks reworking it. In this post, I describe the problems with the old structure and the new structure. Then I explain how I handled backward compatibility, which was the hardest part.

## Problems with the Old Structure

The old `Reward` had a place for the original reward (`origin`). But there was no separate place for converted rewards. So each reward type expressed conversions in its own way. Below is simplified code to make it easier to follow. To keep it short, I only show four reward types.

```scala
// Before (simplified)
case class Reward(origin: RewardElement, ...)

// A conversion result is also a RewardElement.
case class ConvertedReward(rewards: List[RewardElement], replacedAmount: Long) extends RewardElement

case class Stone(id: StoneId, amount: Long, convertedReward: Option[ConvertedReward])                  extends RewardElement
case class PreexistingTreasure(id: TreasureId, amount: Long, convertedReward: Option[ConvertedReward]) extends RewardElement
case class PreexistingSkin(skinId: SkinId, convertedReward: ConvertedReward)                           extends RewardElement
case class PreexistingStructure(structureId: StructureId, rewards: ConvertedReward)                    extends RewardElement
```

This structure had four problems.

- **There is no way to say that there is no original reward.** `origin` is not an `Option`, so it must always hold something. Say a user gets a skin they already have. The whole original reward turns into other rewards, so there is no original reward to give. But `origin` can't be empty. So we made types like `PreexistingSkin` that wrap the conversion, and put them in `origin`.
- **Conversions live in a different place for each type.** `Stone` and `PreexistingTreasure` hold the amount given and the conversion together, and the conversion is an `Option`. `PreexistingSkin` and `PreexistingStructure` hold only the conversion, and it is not an `Option`. The field names are also different: `convertedReward` and `rewards`.
- **You can't tell what was converted.** `ConvertedReward` only has the amount that was replaced (`replacedAmount`). You have to guess what was replaced from the type that wraps it. On top of that, `ConvertedReward` is also a `RewardElement`, so it can be nested anywhere inside other rewards.
- **It is easy to miss converted rewards.** The code that applies rewards to the user state had to pull out the nested converted rewards for each type. Then it had to apply them separately.

```scala
// Before: each case must apply its own nested conversion.
case Stone(id, amount, convertedReward) =>
  addStone(id, amount) *> convertedReward.traverse_(applyReward)
case PreexistingTreasure(id, amount, convertedReward) =>
  addTreasure(id, amount) *> convertedReward.traverse_(applyReward)
case PreexistingSkin(_, convertedReward) =>
  applyReward(convertedReward)
case PreexistingStructure(_, rewards) =>
  applyReward(rewards)
// ... and so on for every reward type
```

If you miss even one place, the converted reward silently disappears. In practice, this kind of bug was easy to introduce.

The client had the same problem. To interpret the rewards in a response, it had to know different rules for each reward type. And whoever added a new reward type expressed conversions in their own way each time.

So everyone agreed that this structure was a problem. But we disagreed on how to fix it. One idea was to keep the current structure and only unify how each reward holds its conversion. For example, if `RewardElement` has `convertedReward` as an abstract method, every reward type is forced to implement it.

```scala
// Another option: force every reward element to expose its conversion.
sealed trait RewardElement {
  def convertedReward: Option[ConvertedReward]
}
```

But this approach had limits.

- **It still can't express a missing original reward.** The conversion lives inside the original reward. So even when the whole original reward is converted, we still need an original reward to hold the conversion. We would still need types like `PreexistingSkin`.
- **The nesting does not go away.** The rewards inside a `ConvertedReward` are also `RewardElement`s, so each of them has its own `convertedReward`. Conversions can still be nested at any depth.
- **Protobuf can't force it.** Protobuf messages have no inheritance, so each message needs its own conversion field. The client still has to look inside each reward type.

Reward types grow every time a new product comes out. So I thought we had to change the structure itself, even with the risk to backward compatibility.

## New Structure: Original Reward and Converted Reward

The new `Reward` puts the original reward and the converted reward in separate slots.

```scala
// After (simplified)
case class Reward(
  originReward: Option[RewardElement],      // the original reward that was actually given
  convertedReward: Option[ConvertedReward], // the part of the original reward that was converted
  ...
) {
  lazy val allRewardElements: List[RewardElement] =
    originReward.toList ++ convertedReward.toList.flatMap(_.rewards) ++ ...
}

case class ConvertedReward(
  rewards: List[RewardElement], // what it became
  replacedOriginQuantity: Long, // how many of the original were replaced
  replacedOriginId: RewardId    // what was replaced
)

// Reward elements no longer carry their own conversions.
case class Stone(id: StoneId, amount: Long)                  extends RewardElement
case class PreexistingTreasure(id: TreasureId, amount: Long) extends RewardElement
// PreexistingSkin and PreexistingStructure are gone.
// When the whole reward is converted, originReward is None and convertedReward holds the result.
```

Here is what changed.

- Conversions now go into one fixed place, `convertedReward`. This is the same for every reward type.
- `ConvertedReward` is no longer a `RewardElement`. So it can't be nested inside other rewards.
- `ConvertedReward` records what was replaced (`replacedOriginId`) and how many (`replacedOriginQuantity`).
- If the whole original reward was converted, like a skin the user already has, `originReward` is empty. We no longer need types that wrap the conversion.
- When we give a reward, we use `allRewardElements` to flatten all the slots at once. Then we apply them to the state.

But `PreexistingTreasure` stays in the new structure. A user can have only one of each skin. So when they get a skin they already have, the whole original reward turns into other rewards. A structure they already have is also converted as a whole. So the original reward slot is empty, and we no longer need `PreexistingSkin` and `PreexistingStructure`. Treasure is different. Its maximum count is not 1. It is a value defined in the game data. For example, if the maximum is 5 and the user has 2, they can get 3 more. So even for a treasure the user already has, they still get more up to the limit. Only the amount over the limit turns into other rewards. The amount added to the treasure they already have must go into the original reward slot. That is why `PreexistingTreasure` stays.

## Backward Compatibility: The Hardest Part

### User State Is Just Serialized Bytes

Our server uses event sourcing. User state is stored in the DB as events (the journal) and snapshots. Both are bytes serialized with protobuf. I covered event sourcing in detail in a [previous post](/journal-optimization-strategies/).

When we deploy the new structure, the new application has to read bytes written by the old application. Two things can go wrong here.

1. **Replay fails completely.** If we can't read the old bytes with the new structure, we can't build the user state.
2. **Replay works, but the state is silently broken.** The bytes are read without errors, but values go to the wrong fields or disappear. This is more dangerous because nobody notices.

So we had to guarantee both. The new application must be able to read the old bytes. And it must move the values it reads into the right fields of the new structure.

### Protobuf Backward Compatibility Basics

When protobuf turns a message into bytes, it does not store field names. It only puts the field number and the wire type in front of each value. So backward compatibility mostly depends on field numbers. These are the rules this post needs.

- **Fields are read by number.** If you rename a field but keep its number, old bytes are still read the same way. If you change the number, the old value is lost.
- **A field missing from the bytes is read as its default value.** So you can add a new field and still read old bytes. In old bytes, the new field is empty.
- **Don't reuse the number of a deleted field.** If another field uses that number, values in old bytes are read into the wrong field. This is the "silently broken" case from above.
- **Changing a field's type is also risky.** Only some types are compatible with each other. Other changes read old values wrongly.

The full rules are in [Updating A Message Type](https://protobuf.dev/programming-guides/proto3/#updating) in the official protobuf documentation. The documentation also suggests keeping a field and renaming it with a prefix like `OBSOLETE_`, instead of deleting it. Adding `Deprecated` in this post works the same way.

### Keeping Protobuf Field Numbers

Following these rules, I kept the numbers of old messages and fields and only renamed them to `Deprecated...`. I added the new structure with new numbers.

```protobuf
message RewardElement {
  oneof value {
    // Old data: keep the numbers, rename to Deprecated.
    DeprecatedStoneReward deprecated_stone = 12;
    DeprecatedConvertedReward deprecated_converted = 36;
    // ...

    // New structure: new numbers.
    StoneReward stone = 54;
  }
}
```

The messages under the new numbers are also new. Old bytes never reach them, so their field numbers start again from 1. For example, here is the new stone reward. Unlike the old message, it has no field for converted rewards.

```protobuf
// A new message: old bytes never reach it, so the numbers start fresh.
message StoneReward {
  int32 stone_id = 1;
  int64 amount = 2;
}
```

This way, old bytes are read as old messages. What remains is to move those values into the new structure. There are two ways to do this.

### Method 1: Convert in the Layer That Reads from the DB

The first method is to handle it in the layer that turns DB bytes into application objects (proto → domain conversion). Let's take treasure rewards as an example. The old treasure reward had a field for converted rewards.

```protobuf
// Before
message PreexistingTreasureReward {
  int32 treasure_id = 1;
  int64 amount = 2;
  ConvertedReward converted_reward = 3;
}
```

In the new structure, a treasure reward only has the treasure and the amount. Extra treasure goes into the `convertedReward` of `Reward`. I kept the old field only in the proto, with the same number and the new name `deprecated_converted_reward`.

```protobuf
// After
message PreexistingTreasureReward {
  int32 treasure_id = 1;
  int64 amount = 2;

  // Only for reading old data. Always empty when we write.
  DeprecatedConvertedReward deprecated_converted_reward = 3;
}
```

When we write, we always leave `deprecated_converted_reward` empty. So when we read, an empty field means the data has already been handled. Old data without a conversion is also empty, and we can read it as it is too. If there is a value, the data was written with the old structure. We treat it as seen for the first time and move it to the new structure the moment we read it.

```scala
def decode(proto: PreexistingTreasureReward): Result[RewardElement] = {
  val treasure = PreexistingTreasure(TreasureId(proto.treasureId), proto.amount)

  proto.deprecatedConvertedReward match {
    // Empty: already handled. Read it as it is.
    case None =>
      treasure.valid
    // Not empty: written with the old structure. Handle it for the first time.
    case Some(old) =>
      decodeForDeprecated(treasure, old) // explained below
  }
}
```

The advantage of this method is that the old structure stays only in the proto. The domain model's `PreexistingTreasure` has no old fields. Application code does not need to know about the old structure at all.

### Method 2: Read a Default Value and Convert in Migration Logic

Method 1 only works when we can build the new value from the DB bytes alone. But sometimes building the new value needs outside information, such as game data. The reading layer can't see game data.

For example, say the old state stored only a `level` to show how far the user had received pass rewards. The new structure stores the ids of the received rewards (`receivedRewardIds`). The rewards for each level are defined in the game data. So we can't build this list from the DB bytes alone. In this case, we read the new field with a default value (`None`). Then we fill it in with migration logic that can see the game data. The migration runs only once, for states where the new field is still empty.

The old proto only has the pass id and the level.

```protobuf
// Before
message PassReward {
  int32 pass_id = 1;
  int32 level = 2;
}
```

In the new proto, field 2 keeps its number and is only renamed to `deprecated_level`. The new field is added as field 3.

```protobuf
// After
message PassReward {
  int32 pass_id = 1;
  int32 deprecated_level = 2;                // same number: old bytes still fill it
  ReceivedRewardIds received_reward_ids = 3; // new number: not in old bytes
}

message ReceivedRewardIds {
  repeated int32 reward_ids = 1;
}
```

There are two reasons this proto is backward compatible.

- **The old value is still read.** Field 2 kept its number and only got a new name. Protobuf reads by number, so the level in old bytes goes straight into `deprecated_level`.
- **The new field is read as empty.** Old bytes don't have field 3. Protobuf reads a field that is missing from the bytes as its default value, without an error. So the new application reads old bytes without problems, and `received_reward_ids` is empty.

There is also a reason why `received_reward_ids` is wrapped in a message instead of being a `repeated` field. A `repeated` field that is missing from the bytes is read as an empty list. Then we can't tell old data that has not been migrated from new data with no received rewards. With a message field, we can tell when it is missing. So the domain model reads it as `None`, and we know that the state needs migration.

After this, the new field is still empty. Migration logic that can see the game data fills it in.

```scala
// Before
case class PassReward(passId: PassId, level: Int)

// After
case class PassReward(
  passId: PassId,
  receivedRewardIds: Option[Set[RewardId]], // new field: None when read from old data
  deprecatedLevel: Int                      // old field: renamed, but still kept in the app
)

// Migration logic can read the game data.
def migratePassReward(passId: PassId): Program[Unit] =
  for {
    state     <- getPassReward(passId)
    level      = state.deprecatedLevel                    // the old value we kept
    rewardIds <- inquireRewardIdsUpToLevel(passId, level) // look it up in the game data
    _         <- setReceivedRewardIds(passId, rewardIds)  // fill in the new field
  } yield ()
```

This method costs more, though. The migration logic has to read the old value. So we have to keep the old field in the application, only renamed, like `deprecatedLevel`. With method 1, we could keep the old structure only in the proto and remove it from the application. So if you can handle it with the bytes alone, method 1 is better.

### A Last-Minute Bug and ForDeprecated

I thought I was done. But at the last minute, I found a bug that made replay fail. I found it while reading heavy users' snapshots with the old and new images and comparing them. The cause was the gacha history (`GachaHistory`). The gacha history is stored in the user state, and it holds the Rewards the user received as they are. So old gacha history still had rewards in the old structure, such as the old `ConvertedReward`.

But at first, I had deleted these old reward types from the proto. So when we read old gacha history, those places were read as empty. An empty reward can't be turned into a domain object, so reading failed with an error. This is the "replay fails completely" case from above.

So I brought the deleted old reward types back with the same numbers and added `Deprecated` to their names. But some of this old data could not be split exactly into the new structure. For example, the old `ConvertedReward` does not record what was replaced. So we can't fill in `replacedOriginId`.

So I added a reward type called `ForDeprecated` and put all such old data into it.

```scala
@deprecated("Only used for preexisting journals")
case class ForDeprecated(rewards: List[RewardElement]) extends RewardElement

// Replaying an old event: apply every reward inside.
case ForDeprecated(rewards) =>
  rewards.traverse_(applyReward)
```

`ForDeprecated` is only created when reading old data, such as old events or old gacha history. New code never creates this type. When replaying old events, what matters is that the same rewards are applied to the state in the same way. There is no need to split past rewards into the new structure again. So `ForDeprecated` just applies every reward inside it to the state. For example, an old treasure reward with a conversion is read as one `ForDeprecated`. It holds both the original reward and the converted rewards.

```scala
// An old treasure reward with a conversion is read as one ForDeprecated.
ForDeprecated(List(PreexistingTreasure(treasureB, 3), Coin(500), Coin(500)))
```

## Verification

There were two criteria for verification.

1. Data in the DB must be readable by both the old image (the server before the rework) and the new image (the server after the rework).
2. The field values of the state read by the two images must be the same.

I picked the snapshots of 20 heavy users. I read each one with the old image and the new image and compared the field values. This comparison is also how I found the gacha history bug above. For all users, the data team ran a replay and checked that no errors occurred. In other words, we compared the actual values for only 20 users.

If I did it today, I would build a tool like a verifier first, before starting the work. It would read the same user data with the old and new images. Then it would compare the field values automatically. That way, we could compare all users, not just 20. We could also repeat the same comparison every time we change a reward type.

## Results

The effect was what we intended. Now you can tell what happened just by looking at a single Reward. And you can read it the same way no matter the reward type.

For example, when a user gets a skin they already have, the following Reward comes back.

```scala
Reward(
  originReward = None,
  convertedReward = Some(ConvertedReward(
    rewards = List(Crystal(100)), // example substitute reward
    replacedOriginQuantity = 1,
    replacedOriginId = skinA
  )),
  ...
)
```

You can read it right away: "The user was meant to get 1 skin A, but they already had it, so it turned into 100 crystals."

When a user gets 5 of a treasure but can only hold 3 more, it looks like this.

```scala
Reward(
  originReward = Some(PreexistingTreasure(treasureB, 3)),
  convertedReward = Some(ConvertedReward(
    rewards = List(Coin(500), Coin(500)), // example substitute rewards
    replacedOriginQuantity = 2,
    replacedOriginId = treasureB
  )),
  ...
)
```

You can read this as "The user got 3 treasure B, and the 2 extra turned into other rewards." The two rewards have different types, but you read them the same way. `originReward` shows what was actually given. `convertedReward` shows what was converted, how many, and into what.

There were other changes as well.

- When adding a new reward type, we no longer have to think about how to express conversions.
- Both server and client developers find the reward structure easier to understand and use.
- Since it went live, we have not had to ship a hotfix because of this rework.

## Before and After at a Glance

Here are all the changes from this post in one place.

### Protobuf

```protobuf
// Before
message RewardElement {
  oneof value {
    PreexistingTreasureReward preexisting_treasure = 6;
    StoneReward stone = 12;
    ConvertedReward converted = 36;
    // ...
  }
}

message ConvertedReward {
  repeated RewardElement rewards = 1;
  int64 replaced_amount = 2;
}

message PreexistingTreasureReward {
  int32 treasure_id = 1;
  int64 amount = 2;
  ConvertedReward converted_reward = 3;
}

message StoneReward {
  int32 stone_id = 1;
  int64 amount = 2;
  ConvertedReward converted_reward = 3;
}
```

```protobuf
// After
message RewardElement {
  oneof value {
    PreexistingTreasureReward preexisting_treasure = 6;
    DeprecatedStoneReward deprecated_stone = 12;
    DeprecatedConvertedReward deprecated_converted = 36;
    // ...

    StoneReward stone = 54;
    ForDeprecated for_deprecated = 55;
  }
}

message ConvertedReward {
  repeated RewardElement rewards = 1;
  int64 replaced_origin_quantity = 2;
  int32 replaced_origin_id = 3;
}

// The old ConvertedReward, renamed. Only for reading old data.
message DeprecatedConvertedReward {
  repeated RewardElement rewards = 1;
  int64 replaced_amount = 2;
}

message PreexistingTreasureReward {
  int32 treasure_id = 1;
  int64 amount = 2;

  // Only for reading old data. Always empty when we write.
  DeprecatedConvertedReward deprecated_converted_reward = 3;
}

// The old StoneReward, renamed. Only for reading old data.
message DeprecatedStoneReward {
  int32 stone_id = 1;
  int64 amount = 2;
  DeprecatedConvertedReward deprecated_converted_reward = 3;
}

message StoneReward {
  int32 stone_id = 1;
  int64 amount = 2;
}

message ForDeprecated {
  repeated RewardElement rewards = 1;
}
```

### Domain Model

```scala
// Before
case class Reward(origin: RewardElement, ...)

case class ConvertedReward(rewards: List[RewardElement], replacedAmount: Long) extends RewardElement

case class Stone(id: StoneId, amount: Long, convertedReward: Option[ConvertedReward])                  extends RewardElement
case class PreexistingTreasure(id: TreasureId, amount: Long, convertedReward: Option[ConvertedReward]) extends RewardElement
case class PreexistingSkin(skinId: SkinId, convertedReward: ConvertedReward)                           extends RewardElement
case class PreexistingStructure(structureId: StructureId, rewards: ConvertedReward)                    extends RewardElement
```

```scala
// After
case class Reward(
  originReward: Option[RewardElement],
  convertedReward: Option[ConvertedReward],
  ...
)

case class ConvertedReward(rewards: List[RewardElement], replacedOriginQuantity: Long, replacedOriginId: RewardId)

case class Stone(id: StoneId, amount: Long)                  extends RewardElement
case class PreexistingTreasure(id: TreasureId, amount: Long) extends RewardElement
// PreexistingSkin and PreexistingStructure are gone.
// When the whole reward is converted, originReward is None and convertedReward holds the result.

@deprecated("Only used for preexisting journals")
case class ForDeprecated(rewards: List[RewardElement]) extends RewardElement
```

## Conclusion

The Reward structure rework did not have an immediate business impact. It was also risky work, because handling backward compatibility badly could break user data. Still, reward types keep growing in our project. Now we can understand what happened to a reward through one consistent structure. That was worth the risk.

Here is what I learned about backward compatibility.

- User state is just serialized bytes. You must check that the new application can read the old bytes. You must also check that the values move to the right places.
- In protobuf, keep the field numbers. Keep old fields, and only rename them to `Deprecated...`.
- If you can move the data with the bytes alone, do it in the reading layer. If you need outside information like game data, do it in migration logic.
- Put old data that can't be split into the new structure in a separate type like `ForDeprecated`. Its only job is to make sure the same rewards are applied to the state.
- For verification, the more you automate it across all users instead of a few, the better.
