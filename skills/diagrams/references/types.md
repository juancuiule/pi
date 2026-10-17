# Diagram types

What are you showing? Pick the row that matches, copy its smallest example, and grow it. Every example here renders in pele.

| Showing                                        | Type                |
| ---------------------------------------------- | ------------------- |
| A process, decision, or flow                   | `flowchart`         |
| Actors exchanging messages in order            | `sequenceDiagram`   |
| Types, classes, or modules and their relations | `classDiagram`      |
| States and the transitions between them        | `stateDiagram-v2`   |
| Tables or entities and their relations         | `erDiagram`         |
| Work over calendar time                        | `gantt`             |
| Events in order on one line                    | `timeline`          |
| Branches and merges                            | `gitGraph`          |
| Parts of a whole (a few)                       | `pie`               |
| Ideas branching from a center                  | `mindmap`           |
| Steps and how they feel                        | `journey`           |
| Items on two axes                              | `quadrantChart`     |
| Numbers over categories                        | `xychart-beta`      |
| Quantities flowing between nodes               | `sankey-beta`       |
| Services and groups in a system                | `architecture-beta` |
| A system and its actors, C4-style              | `C4Context`         |
| Boxes in a grid                                | `block-beta`        |
| Work cards in columns                          | `kanban`            |

pele also draws `requirementDiagram`, `swimlane-beta`, `agentflow-beta`, `railroad-beta`, `treeView-beta`, `cynefin-beta`, `wardley-beta`, `eventmodeling`, `usecase-beta`, `venn-beta`, `ishikawa`, `packet`, `radar-beta`, `treemap` and `info`. Use one only when the request names it or you know its syntax cold; there is no example here.

## Flowchart — processes and decisions

```mermaid
flowchart TB
  A[Start] --> B{Ready?}
  B -->|yes| C[Ship it]
  B -->|no| D[Fix it]
  D --> B
```

Node text in `{}` is a decision, `[]` a step. Group related nodes in `subgraph name ... end`.

## Sequence — actors exchanging messages

```mermaid
sequenceDiagram
  participant U as User
  participant S as Server
  U->>S: request
  S-->>U: page
```

`->>` is a call, `-->>` a return. Name actors with `as` so the labels read well.

## Class — types and relations

```mermaid
classDiagram
  class Seat {
    +level
    +upgrade()
  }
  Seat --> Sandbox
```

## State — states and transitions

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Published: publish
  Published --> [*]
```

## ER — entities and relations

```mermaid
erDiagram
  CONVERSATION ||--o{ ENTRY : has
  CONVERSATION {
    int id
    string title
  }
```

## Gantt — work over calendar time

```mermaid
gantt
  title Plan
  dateFormat YYYY-MM-DD
  section Build
  Write :a1, 2026-10-17, 3d
  Review :after a1, 2d
```

A task is `name :id, start, length`; chain with `after <id>`.

## Timeline — events in order

```mermaid
timeline
  title Releases
  2024 : v1
  2025 : v2
  2026 : v3
```

## Git graph — branches and merges

```mermaid
gitGraph
  commit
  branch feature
  checkout feature
  commit
  checkout main
  merge feature
```

## Pie — parts of a whole

```mermaid
pie title Share
  "Alpha" : 45
  "Beta" : 30
  "Other" : 25
```

## Mindmap — ideas branching from a center

```mermaid
mindmap
  root((Project))
    Frontend
      Console
    Backend
      Agents
```

Indentation is the structure. `((x))` is a circle, `[x]` a rectangle.

## Journey — steps and how they feel

```mermaid
journey
  title Signup
  section Try
    Open page: 4: User
    Fill form: 2: User
```

Each step scores 1-5 and names its actor.

## Quadrant — items on two axes

```mermaid
quadrantChart
  title Reach
  x-axis Low --> High
  y-axis Easy --> Hard
  A: [0.7, 0.8]
  B: [0.2, 0.3]
```

Points are `[x, y]` from 0 to 1.

## XY chart — numbers over categories

```mermaid
xychart-beta
  title Growth
  x-axis [Jan, Feb, Mar]
  y-axis "Users" 0 --> 100
  bar [10, 40, 80]
  line [10, 40, 80]
```

## Sankey — quantities flowing between nodes

```mermaid
sankey-beta
  Source,A,10
  Source,B,5
  A,Sink,8
  B,Sink,5
```

One `from,to,amount` per line; nodes come from the names used.

## Architecture — services in groups

```mermaid
architecture-beta
  group api(cloud)[API]
  service web(server)[Web] in api
  service db(database)[DB] in api
  web:R --> L:db
```

## C4 — a system and its actors

```mermaid
C4Context
  title System
  Person(user, "User")
  System(app, "App")
  Rel(user, app, "Uses")
```

## Block — boxes in a grid

```mermaid
block-beta
  columns 2
  A B
  C["wide"]:2
```

A label followed by `:n` spans n columns.

## Kanban — work cards in columns

```mermaid
kanban
  Todo
    task1[Write]
  Done
    task2[Plan]
```
