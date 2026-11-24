---
title: 'Building a Reliable Server Maintenance with ZIO'
description: 'I want to share my journey to improve our server maintenance process by adopting ZIO. I''ll walk you through my experiences, why I chose ZIO, and how I...'
pubDate: 2025-06-27
tags: ['fp', 'scala-cli', 'scopts', 'scripts', 'zio']
---

## Intro

I want to share my journey to improve our server maintenance process by adopting **ZIO**. I'll walk you through my experiences, why I chose ZIO, and how I actually implemented it.

## The Problem: Manual Maintenance was Clumsy and Risky

Our server maintenance involved a complex series of steps: muting Datadog alerts (to prevent false alarms when servers go down), taking down servers (`kubectl delete`), scaling out servers for huge loads (`kubectl patch hpa`), backing up Redis and databases, and restarting servers.

This maintenance process was, to be frank, a bit **old-fashioned**. The day before maintenance, I'd meticulously write down the "Maintenance Scenario" in Notion. On the day itself, I'd **copy and paste each command** one by one into the terminal and execute them.

Sure, this method had its perks. It was easy to attach images, use Markdown for highlighting important parts or code blocks, and simply write plain text to add specific details for a particular build.

However, it came with clear **problems**:

1. **Time-Consuming and Inefficient**
    1. First of all, having multiple terminal windows open and constantly copying and pasting commands took a lot of time. **Minimizing downtime can have a significant business impact**, as no revenue is generated while systems are down.
2. **Prone to Errors and Hard to Reuse**
    1. Because the maintenance scenarios were long and complex, there was a high **chance of making mistakes**. This was especially true when entering values that changed every time, like dates or versions.
    2. For instance, I might correctly enter a date **250624** for the DB backup file name but make a mistake for the Redis backup file name. And the name of the current build would be used in various places throughout the scenario. Trying to manually update all these instances could easily lead to errors. Copying and pasting content from a previous maintenance scenario to a new one also has a risk of leading to mistakes. Even though I tried creating Notion templates to improve this, it didn't solve the fundamental issue.
3. **Lack of Version Control**
    1. Notion documents didn't offer a user-friendly history of who made what changes and when, making **version control practically impossible**. This also meant it was **difficult to see the diffs between maintenance scenarios from previous builds**, making review and comparison a challenge.

## A New Vision: Configurable and Stable Maintenance

To tackle these issues, I envisioned a new **blueprint**:

- **Configurable Parameters**:
    - I wanted to manage only the parts that changed for each maintenance session as **configurable values**. This would allow us to modify just these settings and reuse the rest of the logic, leading to a more efficient structure.
- **Interactive Scenario Execution**:
    - I aimed for an **interactive** execution where the prompt would show each step in advance, and then I'd press `Y` to proceed to the next, similar to a guided process.

Based on this blueprint, I further refined our **implementation requirements**:

- **Dry-run Feature**: Before actually running commands, a **dry-run feature** should show exactly what commands would be executed, helping us review all the steps and prevent mistakes.
- **Step Retry and Skip**: If an issue occurred at a specific step, I needed the ability to **retry** it or **skip** unnecessary steps.
- **Scenario Step Resumption**: If one step execution was interrupted, I needed a way to **resume from a specific step**.
- **Parallel Execution**: Independent steps should be able to run **in parallel** to further shorten maintenance time.

\=> Setting up these requirements, I decided that building this as an **application** would be far more effective than just writing a simple `.sh` script. My chosen solution was a combination of **Scala-CLI, Scopt, and ZIO**.

## Scala-CLI, Scopt, and ZIO

To implement my server maintenance scenario as an application, I leveraged Scala along with **Scala-CLI**, **Scopt**, and **ZIO**.

### Scala-CLI: Easy Scala Scripting

> [https://scala-cli.virtuslab.org/](https://scala-cli.virtuslab.org/)

**Scala-CLI** is a tool that makes it easy to run and manage Scala code like a script. You don't need complex build configurations; you can just compile and run Scala code directly from a single file or multiple files, providing great convenience.

Let's look at a simple example: Create a `hello.scala` file with the following content:

```scala
//> using scala "3.3.1"
//> using lib "com.lihaoyi::os-lib::0.9.2"

object Hello:
  def main(args: Array[String]): Unit =
    println(s"Hello, ${args.headOption.getOrElse("World")}!")
```

You can then run this file like so:

```bash
> scala-cli hello.scala Alice
# Output: Hello, Alice
```

As you can see, Scala-CLI simplifies Scala development environment setup and offers an optimized experience for scripting tasks.

### Scopt: A Powerful Tool for Terminal Command Parsing

> [https://github.com/scopt/scopt](https://github.com/scopt/scopt)

In my prompt, I used the **Scopt** library to parse commands entered in the terminal into Scala code. Scopt is incredibly useful for defining and parsing command-line arguments. For example, Scopt was used to handle the `help` option in my customed `scenario-runner` command. With Scopt's `OParser`, you can easily define standard options like `help` and `version`, as well as custom options and commands, and add descriptions for each.

```scala
import scopt.OParser
val builder = OParser.builder[Config]
val parser1 = {
  import builder._
  OParser.sequence(
    programName("scopt"),
    head("scopt", "4.x"),
    // option -f, --foo
    opt[Int]('f', "foo")
      .action((x, c) => c.copy(foo = x))
      .text("foo is an integer property"),
    // more options here...
  )
}

// OParser.parse returns Option[Config]
OParser.parse(parser1, args, Config()) match {
  case Some(config) =>
    // do something
  case _ =>
    // arguments are bad, error message will have been displayed
}
```

### ZIO: The Powerhouse for Asynchronicity and Error Handling

> [https://zio.dev/](https://zio.dev/)

**ZIO** is a functional programming library in Scala that helps you handle asynchronous operations, concurrency, and error management easily and safely. It's actively used not only in my prompt project but also in our main business logic. For more information on ZIO, you can visit there.

Here are the key advantages of choosing ZIO:

- **Clarity of the R, E, A Model**: ZIO's `ZIO[R, E, A]` model clearly exposes `R` (Environment), `E` (Error type), and `A` (Success value type). Crucially, **`R` perfectly aligned with my goal of "managing configurable parts for each maintenance session."** By exposing necessary configuration information in the `R` type, developers can clearly understand what configuration the steps will run under. This is a significant advantage of a static type system, and one of the main reasons I particularly favor ZIO.
- What truly makes ZIO powerful for my use case, especially with an interactive prompt, is the ability to **flexibly compose environments using ZLayer's `>>>` (forward composition) or `++` (parallel composition) operators**. This allows us to combine various environmental dependencies as needed, making my program highly modular and adaptable to different maintenance scenarios without rewriting core logic. For example, I can easily swap out a "live database access" layer for a "mock database" layer during dry-run or testing, or dynamically add a "notification service" layer based on the current scenario's requirements. This composability is a core reason why I particularly favor ZIO.

```scala
trait Config
trait Logger
trait Db
trait Service

val configLayer: ZLayer[Any, Nothing, Config] = ???
val loggerLayer: ZLayer[Any, Nothing, Logger] = ???
val dbLayer: ZLayer[Config, Nothing, Db] = ???
val serviceLayer: ZLayer[Db with Logger, Nothing, Service] = ???

val envLayer: ZLayer[Any, Nothing, Service] =
  (configLayer >>> dbLayer) ++ loggerLayer >>> serviceLayer
```

```text
    [ configLayer ]       
           │                     
           ▼                     
      ┌────────┐           ┌────────┐
      │  Db    │           │ Logger │
      │ (via   │           │        │
      │ dbLayer)           └────────┘
      └────┬───┘                │
           │       (++)        │
           └─────────┬─────────┘
                     ▼
                ┌────────┐
                │Service │
                │ (via   │
                │service │
                │Layer)  │
                └────────┘
```

**Excellent Concurrency Control**: The requirement to "run specific steps in parallel" is another area where ZIO shines. ZIO helps users handle **concurrent tasks with remarkable ease**. For example, independent tasks like backing up a database and creating a Redis snapshot can be run in parallel using ZIO's `zipPar` (`<&>`) operator, waiting for both to complete.Scala

```scala
// Assuming these are conceptual ZIO effects
val backupDb: ZIO[Any, Throwable, Unit] = ???
val createRedisSnapshot: ZIO[Any, Throwable, Unit] = ???

// Run both tasks in parallel and wait for both to complete
val parallelBackupAndSnapshot = for {
  _ <- backupDb <&> createRedisSnapshot // Using ZIO's <*> operator for parallel execution
} yield ()
```

**Robust Error Handling**: ZIO provides a powerful error handling mechanism that allows for more stable responses to exceptional situations. This is extremely helpful in predicting and handling various errors that can occur in complex server maintenance scenario execution.

## How My Interactive Prompt Are Used

You can use the `show` command to preview each step of the entire scenario:

```bash
❯ ./scenario-runner show
# Displaying each step of the scenario and a summary of commands (generalized for security)
You can access the scenario unit by index.
[0]: [Server] Muting Datadog alarms
    $ ./datadog downtime create YYYYMMDD YYYYMMDD my-build
# ... (omitted)
[9]: [Server] Create Redis job script
    # Redis backup and cleanup script creation (internal details omitted)
    # E.g., creating and setting permissions for ~/redis-job.sh
# ... (omitted)
[11]: [Server] Take a full CRDB backup
    $ echo "BACKUP INTO 's3://my-s3-bucket/backup/spot/YYYYMMDD?AUTH=implicit' AS OF SYSTEM TIME '-10s' WITH detached;" | ./ops db-cli prod-live -Y
# ... (omitted)
[14]: [Server] Take a full Redis backup
    $ AWS_PROFILE=my-profile aws elasticache create-snapshot \\\\\\\\
    --cache-cluster-id my-cache-cluster-id \\\\\\\\
    --snapshot-name my-cache-snapshot-YYYYMMDD \\\\\\\\
    --no-cli-pager
# ... (omitted)
[15]: [Server] Run Redis script
    $ ~/redis-job.sh
# ... (omitted)
```

We can first review the commands to be executed at each step, and then press the **Y** key to run the script

## Internal Implementation

### 1\. User Input Parsing

For my prompt, I used the **Scopt** library to parse commands entered in the terminal into Scala code. Scopt is incredibly useful for defining and parsing command-line arguments. Commands like `run`, `dry-run`, and `show`, along with arguments like `FROM_INDEX`, are defined and mapped to a `Runner` case class.

```scala
import scopt.OParser
import scopt.Read
import java.time.format.DateTimeFormatter
import java.time.LocalDateTime

// Defining the subcommands that my application will support
sealed trait Subcommand
object Subcommand {
  case class Run(fromIndex: Int, withDryRun: Boolean) extends Subcommand
  case object Show extends Subcommand
}

// The main configuration for my application, which holds the chosen subcommand
case class Runner(
  subcommand: Option[Subcommand] = None
)

// Conceptual code for parsing command-line arguments using Scopt
def parser: scopt.OParser[Unit, Runner] = {
  val builder = OParser.builder[Runner]
  import builder.*

  OParser.sequence(
    programName("scenario-runner"),
    head("scenario-runner"),
    // Define the 'run' command and its behavior
    cmd("run")
      .action((_, c) => c.copy(subcommand = Some(Subcommand.Run(0, false))))
      .text("Run a scenario")
      .children(
        arg[Int]("<FROM_INDEX>")
          .action((x, c) => c.copy(subcommand = c.subcommand.map {
            case r: Subcommand.Run => r.copy(fromIndex = x)
            case other => other
          }))
          .text("Run a scenario starting from the given index (default: 0)")
          .optional()
      ),
    // Define the 'dry-run' command for simulation
    cmd("dry-run")
      .action((_, c) => c.copy(subcommand = Some(Subcommand.Run(0, true))))
      .text("Simulate running a scenario")
      .children(
        arg[Int]("<FROM_INDEX>")
          .action((x, c) => c.copy(subcommand = c.subcommand.map {
            case r: Subcommand.Run => r.copy(fromIndex = x)
            case other => other
          }))
          .text("Simulate running a scenario from the given index (default: 0)")
          .optional()
      ),
    // Define the 'show' command to display scenario details
    cmd("show")
      .action((_, c) => c.copy(subcommand = Some(Subcommand.Show)))
      .text("Show details about a scenario"),
    help('h', "help"),
    note(
      """
        |Example:
        |  scenario-runner run [FROM_INDEX]
        |  scenario-runner dry-run [FROM_INDEX]
        |  scenario-runner show
        |
        |Note:
        |  [FROM_INDEX] is optional. If omitted, it defaults to 0.
        |""".stripMargin
    )
  )
}
```

**Scopt's `OParser` makes it possible to display the elegant usage information shown below**, handling the `help` option in my `scenario-runner` command. With `OParser`, you can easily define standard options like `help` and `version`, as well as custom options and commands, and add descriptions for each.

My `scenario-runner` command can be used as follows:

```bash
❯ ./scenario-runner -h
# Displaying script usage and options (simplified version)
scenario-runner
Usage: scenario-runner [run|dry-run|show] [options] <args>...
Command: run [<FROM_INDEX>]
  Run a scenario
  <FROM_INDEX>             Run a scenario starting from the given index (default: 0)
Command: dry-run [<FROM_INDEX>]
  Run a scenario
  <FROM_INDEX>             Simulate running a scenario from the given index (default: 0)
Command: show
  Show details about a scenario
-h, --help

Example:
  scenario-runner run [FROM_INDEX]
  scenario-runner dry-run [FROM_INDEX]
  scenario-runner show
Note:
  [FROM_INDEX] is optional. If omitted, it defaults to 0.
```

### 2\. Environment (R) Injection

Leveraging ZIO's `R` (Environment), I define maintenance-specific configurations in a `ScenarioConfig` case class. This is then embedded in a `Runner` object and injected via a ZLayer. The `dryRun` status is also part of this `Runner` object, influencing the scenario's execution logic.

```scala
// 1. Define models for maintenance context
case class ScenarioConfig(buildName: String, startsAt: DateTime, repoRoot: os.Path, ...)
case class Runner(config: ScenarioConfig, dryRun: Boolean)

// 2. Construct Layers
val configLayer = ZLayer.succeed(
  ScenarioConfig(buildName = "v1.0", startsAt = DateTime.now(), repoRoot = os.pwd)
)

// 3. Compose the final Environment (Wiring)
// Combine config and CLI input (dryRun) into a single Runner layer
def runnerLayer(isDryRun: Boolean): ZLayer[Any, Nothing, Runner] =
  (configLayer ++ ZLayer.succeed(isDryRun)) >>> ZLayer.fromFunction(Runner.apply)

// 4. Provide the layer to your scenario
val program = Scenarios.targetScenario
  .run(fromIndex)
  .provideLayer(runnerLayer(withDryRunFromCli))
```

### 3\. Scenario Execution Logic

Build scenario is just a `Vector[ScenarioStep]`, defining the entire scenario. **The `Vector[ScenarioStep]` assigns an index to each step, which is used as a unique identifier (key).** The `runScenario` function then executes each `ScenarioStep` sequentially.

Before executing each step, the `previewStepAndAskAction` function previews the step's content and prompts the user to choose an action: run (`y`), skip (`s`), go back (`b`), or exit (`q`). In `dryRun` mode, commands are only displayed and not actually executed.

```scala
case class BuildScenario(steps: Vector[ScenarioStep])

def runScenario(scenario: BuildScenario, startIndex: Int): ZIO[Runner, Throwable, Unit] = {
  // A recursive loop that handles interactive navigation
  def loop(index: Int): ZIO[Runner, Throwable, Unit] = {
    if (index >= scenario.steps.size) 
      ZIO.log("Scenario Completed.")
    else 
        for {
          step   <- ZIO.succeed(scenario.steps(index))
          action <- previewAndAsk(step) // User chooses: y (Next), s (Skip), b (Back), q (Quit)

          nextIndex <- action match {
            case Next => runStep(step).as(index + 1) // Execute and move forward
            case Skip => ZIO.succeed(index + 1)      // Jump to next without execution
            case Back => ZIO.succeed((index - 1).max(0)) // Go back to previous step
            case Quit => ZIO.fail(new Exception("User Aborted"))
          }
          _ <- loop(nextIndex) // Recursive call with the updated index
        } yield ()
  }

  loop(startIndex)
}
```

Since each step in `scenarioSequence` is assigned an index, we can easily implement features like resuming from a specific step using the `FROM_INDEX` option in the `run` command, or allowing users to `Skip` a step during execution.

## Future Directions

While my current server maintenance scenario has brought significant improvements, there's still plenty of room for further development. In particular, I found the [Scala Native conference presentation](https://slides.indoorvivants.com/clis-with-scala-native) very insightful, and based on the ideas presented there, I'm looking to enhance my maintenance scenario execution using the following libraries:

### Projects I’m Thinking of Using It In

#### decline-derive

> [https://github.com/indoorvivants/decline-derive](https://github.com/indoorvivants/decline-derive)

**Improved User Input Parsing (`decline-derive`)**: `decline-derive` and similar libraries could allow us to write user input parsing code in a more declarative and concise way.Scala

```scala
//> using dep com.indoorvivants::decline-derive::0.3.1

import decline_derive.*

enum Sub derives CommandApplication:
  case A(x: Int)
  case B(y: Option[String])

enum Command derives CommandApplication:
  @Help("Hello, LSUG!") case Hello(@Short("n") name: String)
  case Test(a: Sub)

@main def runCommand(args: String*): Unit =
  println(CommandApplication.parseOrExit[Command](args))
```

#### toml-scala

> [https://github.com/sparsetech/toml-scala](https://github.com/sparsetech/toml-scala)

**Configuration Management (`toml-scala`)**: I are considering introducing `toml-scala` for managing configuration files. This would contribute to better structured and more readable configurations.Scala

```scala
//> using dep com.indoorvivants::toml::0.3.0

import toml.*

case class Config(name: String, age: Int) derives Codec@main def parse_toml =
  val string =
    """
    name = "John Doe"
    age = 30
    """
  println(Toml.parseAs[Config](string))
```

#### cue4s

> [https://github.com/neandertech/cue4s/](https://github.com/neandertech/cue4s/)

**Enhanced Terminal Interactivity (`cue4s`)**: `cue4s` and similar libraries could enable richer and more user-friendly terminal interactions (e.g., confirmation prompts, text input).Scala

```scala
//> using dep tech.neander::cue4s::0.0.9

import cue4s.*

@main def prompts =
  Prompts.sync.use: prompts =>
    val name = prompts.text("What is your name?").getOrThrow
    val youOK = prompts.confirm(s"Are you ok, $name?").getOrThrow
    if !youOK then sys.error("You get better mate, come back later")
```

### Ultimate Goal: Web-Based Management System

In the long term, I aim to move the management and execution of this scenario to a web-based platform. My ultimate goal is to build a system that allows us to **integrate with a database**, and then add, modify, delete steps, visualize execution history, and even trigger executions directly from a web page. This would create an even more intuitive and collaborative maintenance process.

## Summary

- My team aimed to solve the inefficiencies and human error risks associated with our traditional manual server maintenance methods. To achieve this, I developed an **automated server maintenance prompt using ZIO**.
- **ZIO's powerful type system and functional approach** enabled clear management of maintenance configurations (via the `R` type), robust error handling, and easy implementation of complex concurrency tasks (parallel execution). Furthermore, **Scala-CLI** streamlined the script's development and deployment, and **Scopt** helped us build a user-friendly command-line interface.
- Currently, the prompt offers various features such as dry-run, step skipping/retrying, and resuming from specific steps, which have significantly reduced maintenance time and increased stability. In the future, I plan to further enhance development convenience using libraries like `decline-derive`, `toml-scala`, and `cue4s`, with the ultimate goal of building a **database-backed web management system** to evolve our maintenance process even further.
- My improvements to server maintenance scenario execution with ZIO have greatly boosted our team's efficiency and reduced the risk of human error.
