# flowgraph

Shows what the code of a Swift (or C, C++, Objective-C) project calls, reads, writes, and uses, in one web page.

The tool has two parts:

- `flowgraph snapshot` reads the index store that the compiler writes during a build, and writes a **snapshot**: one JSON file with the symbols and the edges of the project. Each edge is what the compiler resolved, not a match by name.
- The **viewer** is a web page that opens a snapshot. It is the same page for every project.

## Use

    swift build -c release
    .build/release/flowgraph snapshot <project-dir> --out snapshot.json
    .build/release/flowgraph page --out flowgraph.html
    open flowgraph.html          # then choose snapshot.json, or drop it on the page

The project must be built first (`swift build`, or a build in Xcode), because the build writes the index.
The snapshot is as fresh as the index: the tool warns when source files changed after the last build.

    flowgraph snapshot [project-dir]   Write the snapshot of a project.
    flowgraph page                     Write the viewer as one HTML file, empty or with a snapshot inside.
    flowgraph site                     Write the viewer as a folder of static files, for a web host.
    flowgraph list entries             Print the entry points that the sources mark.
    flowgraph list products            Print the products of the package and of its checkouts.

`flowgraph --help` lists each option.

## The three forms of the viewer

| Command | Result |
|---|---|
| `flowgraph page` | One HTML file with no data. It asks for a snapshot file. |
| `flowgraph snapshot … --html page.html` or `flowgraph page --snapshot s.json` | One HTML file with the snapshot inside, which opens with a double-click. |
| `flowgraph site --out dir` | `index.html` and the script files, for any static web host. `index.html?snapshot=<url>` opens the snapshot at a link. |

Each form works with no network access: Cytoscape.js and the ELK layout are part of it.
A snapshot that you choose or drop is read in the browser, and it is sent nowhere.

## The page

- Search (`/`) picks a root. Shift adds a second root.
- `callers` and `callees` set the depth on each side, up to `max`.
- Click a symbol: the panel lists who uses it, and what its body holds in the order of the source, each with file and line.
- Double-click a symbol to make it the root.
- The check boxes turn each kind of edge off, and hide data or types.
- Right-click a symbol, or press `h`, to hide it. All that only it led to goes with it, and the rest moves to its new place. The panel lists the hidden symbols, each with a switch to bring it back.
- Each row of the panel has a switch: `−` hides a shown symbol, `+` shows one that no depth reaches.
- `e` or "Expand neighbours" shows every caller, callee, and use of one symbol, whatever the depth.
- `limit` caps the drawn symbols of the graph, nearest to the root first. The status line says how many more are reachable.
- `Open…` loads another snapshot.
- A link can set the view: `page.html?group=none&down=3&data=0#Type.member`. `animate=0` turns the moving layout off, and `view=<id>` picks the view.

## The table

The `Table` tab shows the same symbols as the graph, as rows, with no limit.
With no root it holds every symbol of the project.

- A click on a column title sorts by it, a second click turns the order, and a third gives the order of the scope back.
- `Filter the rows` keeps the rows that hold each word, in the name, the kind, the module, or the file.
- `▸` opens a symbol: the rows under it are who uses it (`←`), then what its body holds in the order of the source (`→`), each with the kind of the edge and the file and line of the site.
- `rows: edges` gives one row for each edge: from, kind, to, the first site, and the number of sites.
- The number columns count over the whole project, so they do not change with the depth.
- A click selects, a double-click makes the root, a right-click hides, and the arrow keys move the selection. The selection is the same in each view.

## The trace

The `Trace` tab shows the body of one function as an outline of its steps, in the order of the source: the function that you selected, or else the first root.

- A step is a statement, or a branch (`guard`, `if`, `else`, `switch` and its cases, a loop, `do` and `catch`, `defer`, a closure) with its steps under it.
- The right column names what the step uses: each call as a box, then what it writes and reads.
- `▸` in a call opens the body of the callee in place, so you follow a path down to its return or its throw.
- `try` marks a step where an error of a callee leaves the function. `try?` and `try!` are struck out, because the error stops there. `await` marks a step where the function can be suspended.
- The panel lists the **ways out** of the function: each `return`, each `throw`, each `try` that passes an error on, and the end of the body. Each has the branches that lead to it, and a click goes to its line. A way out that a `catch` of the function takes is dimmed.
- The table has two more columns from the bodies: `throws` (the places where an error leaves) and `async`.

The trace shows the structure of a body, and the conditions as the source has them. It does not work out which branch runs.

## Mark what you will replace

Select a symbol and press `▣ Mark for replacement`, or `▣ Mark module <name>` for every symbol of a module, for example of a dependency.

- The trace marks each step that uses a marked symbol, and its panel lists each marked site in the path below the function: in its own body, and in the bodies of all that it calls.
- The table has the column `▣ sites`: sort by it to see which functions use the most of what you replace.
- The graph draws a marked symbol with a magenta border.
- The marks stay in the browser for the next visit of the same project. `×` on a mark takes it off.

A project can give its marks, and narrow its entry points, in a `flowgraph.json` beside its `Package.swift`:

    {
      "replace": ["SomeModule", "OtherModule.SomeType"],
      "entries": { "only": ["SomeModule.*"], "except": ["SomeModule.debug*"] }
    }

## Compare two snapshots

The tool only exports. The page compares.

    flowgraph snapshot . --out head.json --html head.html
    flowgraph snapshot . --ref main --out base.json

Open `head.html`, press `Diff…`, and choose `base.json`. The snapshot of the page is the head, and the file that you choose is the base. Both stay on this computer.

`--ref` checks the branch or the commit out in a worktree in the cache directory of the tool, builds it there with `swift build` (or the command of `--build`), and takes the snapshot of that copy. Your working directory does not change. The worktree stays, so the next build of the same ref is short.

With a base chosen, the diff is a mode of the whole page. The graph, the table, and the trace each hold both snapshots as one, and two controls beside the base choose what they show:

| Control | Values |
|---|---|
| `show` | `all`, `changed + affected` (the start), or `changed only`. The walk from the roots still goes through what is the same. |
| `side` | `both` as one, `head only` (the new code), or `base only` (the old code). With one side, each view shows that snapshot alone, so you trace the old path and then the new path of the same function. |

Each symbol of the project gets a state:

| State | Meaning |
|---|---|
| added | The head has it, and the base does not. |
| removed | The base has it, and the head does not. |
| signature changed | The same module, name, and kind, with another signature. |
| body changed | The same symbol, with other steps or other uses. A body that only moved to other lines is not changed. |
| affected | It is the same, and it reaches a symbol that is not. |

- **Trace**: the two bodies are one list of steps. A step that left is red, a step that came is green, and in a step that changed the words that are not in both are lit. A step whose first line is the same and that changed further down has the note `changed`. A call opens in place as before, also a callee that was removed, so a small change far down is seen on the path from the entry point. The ways out that were added and removed are marked.
- **Graph**: a removed symbol and a removed edge are dashed and red, an added edge is green, and a changed symbol has the colour of its state. The old path and the new path are in one picture.
- **Table**: the column `diff` holds the state, and removed symbols are rows. The rows of edges say `added`, `removed`, or the count of sites in the base and in the head.
- **Changes**: the counts of each state, a row for each entry point (its state, the changed symbols that it reaches, and its marked sites in the base and in the head), and the list of the changed symbols. A click opens the symbol in the trace. With marks, it says `N of M marked sites left`.
- `⇄` on the base swaps the two snapshots. `×` ends the diff.
- A hosted page takes both by link: `index.html?snapshot=head.json&base=base.json&view=trace`.

A step is compared by its kind, its text, and what it uses. Comments and white space are not compared.

## By entry point

An entry point is code that a caller outside the project starts:

- a function with `@_cdecl`, `@c`, or `@main`, or a C `main`;
- the top-level code of a `main.swift`;
- a function or a closure that the project hands to a function of a dependency, for example a handler that it registers. Its name is the call that takes it, with the literal arguments: `get("users") { }`. The standard library and the SDK do not count, so a closure for `map` is no entry point.

`entries.only` and `entries.except` of `flowgraph.json` hold patterns of `Module.name` for the functions of dependencies that make entry points.

    flowgraph list entries <project-dir>
    flowgraph snapshot <project-dir> --entry Module.name --out snapshot.json

The view starts at the entry point, goes down to the maximum depth, and shows functions only.
Each function that the entry point calls is one branch, and a group holds what only that branch reaches.
What several branches reach is in the group "shared by several branches".
The `entry` menu of the page changes the entry point, and `group: by entry branch` gives the same groups for any root.
A name can lead with its module, because two modules can export the same name.

## By product

A product of the package is the set of the targets that are linked into it, with the targets that it needs and does not name.

    flowgraph list products <project-dir>
    flowgraph snapshot <project-dir> --product <name> --out snapshot.json

The view holds only the symbols of those targets, starts at the entry points of the product, and has one group for each module.
A library product has no entry point: the panel then lists its functions that nothing calls.
The `product` menu of the page changes the product, and `group: by product` gives one group for each product for any root.

`--checkouts` also reads the sources of the dependencies in `.build/checkouts`, and `group: by package` then gives one group for the project and one for each checkout.

## The edges

| Kind | Meaning |
|---|---|
| calls | the body calls the function |
| refs | the body names a function with no call, for example as a callback |
| reads, writes | the body reads or writes a variable or a property |
| uses | the body names a type |
| inherits | a type inherits from or conforms to another |
| dispatch | an override, or the implementation of a protocol requirement: a call of the base can land here |

## Add a view

The viewer is `Sources/flowgraph/web`:

| File | Content |
|---|---|
| `index.html` | The controls, the tabs, and one `<script>` line for each file below. |
| `core.js` | Reads a snapshot, holds the state that all views share (roots, depths, filters, hidden symbols, the selection), and works out the scope: the symbols that the roots reach. |
| `view-graph.js` | The graph view. |
| `view-table.js` | The table view. |
| `view-trace.js` | The trace view. |
| `diff.js` | The comparison of two snapshots: the merged model that every view reads. |
| `view-changes.js` | The summary of a diff. |

A view is one file that calls `FG.registerView`, and one `<script src>` line in `index.html` before the `FG.start` line:

    FG.registerView({
      id: 'list', title: 'List',
      mount(box, bar) { /* once: build the DOM inside box */ },
      update(scope) { /* after each change: scope.order is the shown symbols, nearest first */ },
      select(id, reveal) { /* the selection changed */ },
    });

`FG.model` holds the symbols (`N`), the edges (`E`), and the edges of each symbol (`out`, `inc`). `FG.body(id)` gives the outline of a body, `FG.exits(id)` its ways out, and `FG.isMarked(id)` the marks. With a base chosen, each symbol, edge, and step has a `diff` field, which `diff.js` documents. A view that does not read it shows both snapshots as one. `FG.state` is the shared state, and a view changes it with `FG.select`, `FG.setRoot`, `FG.hide`, `FG.show`, or by a write to `FG.state` and a call of `FG.refresh()`.
The head of `core.js` documents the snapshot format and the types.

## Limits

- The trace is for Swift. A C function has edges, and no outline.
- Local variables and parameters are not nodes.
- A use inside a closure belongs to the function that holds the closure, unless the closure is an entry point.
- A callee of a dependency has no body in the snapshot, so a `try` of it counts as a place where an error can leave.
