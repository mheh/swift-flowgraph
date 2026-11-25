# flowgraph

Shows what the code of a Swift (or C, C++, Objective-C) project calls, reads, writes, and uses, in one web page.

The tool has two parts:

- `flowgraph snapshot` reads the index store that the compiler writes during a build, and writes a **snapshot**: one JSON file with the symbols and the edges of the project. Each edge is what the compiler resolved, not a match by name.
- The **viewer** is a web page that opens a snapshot. It is the same page for every project.

## Use

    swift build -c release
    .build/release/flowgraph snapshot <project-dir> --out snapshot.json
    .build/release/flowgraph page --out flowgraph.html
    open flowgraph.html          # then drop snapshot.json on the page, or choose it there

The project must be built first (`swift build`, or a build in Xcode), because the build writes the index.
The snapshot is as fresh as the index: the tool warns when source files changed after the last build.
A file that the build did not compile is not in the index. The tool notes the count of such files, and the page says it in the tip of the line under the title.

    flowgraph snapshot [project-dir]   Write the snapshot of a project.
    flowgraph page                     Write the viewer as one HTML file, empty or with a snapshot inside.
    flowgraph site                     Write the viewer as a folder of static files, for a web host.
    flowgraph list entries             Print the entry points that the sources mark.
    flowgraph list products            Print the products of the package and of its checkouts.

`flowgraph --help` lists each option.

## A C or C++ project

The clang of a Swift toolchain, and the clang of Xcode, write the same index when they get `-index-store-path`. Build the project with that flag, and give the directory to the tool:

    cmake -S . -B build -DCMAKE_C_FLAGS="-index-store-path $PWD/build/idx" -DCMAKE_CXX_FLAGS="-index-store-path $PWD/build/idx"
    cmake --build build
    flowgraph snapshot . --sources src --index-store build/idx --out snapshot.json

C names a function by its name alone, so two binaries of one project can each define a function of the same name. The tool keeps them apart:

- A compilation that names no module belongs to a **binary**, which the tool reads from the path of the object file: `<binary>.dir/` of CMake, `<target>.build/` of SwiftPM and of Xcode, and else the directory of the object file.
  Each binary is a module of the snapshot and a product of the page, with the type `binary`.
- A function or a variable that more than one binary defines is one symbol for each of them. A file that is compiled into three binaries gives three sets of symbols.
- A header that one binary reads belongs to that binary. A header that several binaries read is a module of its own, with the name of its directory, and it is in the product of each binary that reads it.
  When a binary has the same name as the directory, the module of the headers is `<name> (shared)`.
- A function that its binary exports is an entry point: the text `visibility("default")` or `dllexport` on its line or on the line above, or a macro there whose definition holds that text.
- A field or a variable that the code calls holds a function. Its kind is `functionField` or `functionVariable`, and the page draws it with the functions.
  A statement that writes such a field and names a function gives a `dispatch` edge from the field to the function, so a path goes from the caller through the table to the function that the table holds.
  The same holds for a Swift variable or property that holds a function.
- A macro that nothing uses is left out.

The outline of a body is read from Swift sources only, so the trace of a C function is empty.

### An index from another computer

An index names each source file by the path that it had in the build. With `--from-index` the tool takes the files from the index and does not look for them on the disk, so the index of another computer, or of a build in a container, gives a snapshot:

    flowgraph snapshot . --from-index --index-store idx --out snapshot.json

The project directory gives the text of the lines when it holds the same sources, at any path. Without the sources, the snapshot has the same symbols and edges, but an exported C function is no entry point, because the tool reads the export from the text.
`--sources` takes directories below the root of the project, as it does without the flag.

## The three forms of the viewer

| Command | Result |
|---|---|
| `flowgraph page` | One HTML file with no data. It starts with the library, which takes snapshot files. |
| `flowgraph snapshot … --html page.html` or `flowgraph page --snapshot s.json` | One HTML file with the snapshot inside, which opens with a double-click. |
| `flowgraph site --out dir` | `index.html` and the script files, for any static web host. `index.html?snapshot=<url>` opens the snapshot at a link. |

Each form works with no network access: Cytoscape.js and the ELK layout are part of it.
A snapshot that you choose or drop is read in the browser, and it is sent nowhere.

## The library

The page keeps each snapshot that you give it in the storage of the browser (IndexedDB), so the next visit has it with no file.
`Library` lists them with the project, the commit, the date of the export, and the size. A page with no snapshot starts there.

- Drop one file or more on the page, or choose them. One file opens at once when the page has no snapshot.
- `Open` shows a snapshot. `Base` compares the open snapshot with that one. `Delete` takes it out of the browser.
- A snapshot from inside the page or from a link is open but not kept, until you press `Keep`.
- The storage belongs to the address of the page. Two page files on a disk can share it or not, as the browser decides, and a hosted page has its own.
- Two exports of one commit are two snapshots. The same file a second time takes the place of the first.

### A snapshot from an index store, in the page

A hosted page can make the snapshot of a C or C++ project itself, so a person who has the build needs no tool:

1. Build the project with `-index-store-path <dir>` (see "A C or C++ project").
2. In the library, press "choose the index store of a build" and pick that directory, or a directory that holds it and the sources.
3. The page reads the files, makes the snapshot, opens it, and keeps it. Nothing leaves the computer.

With the sources in the picked directory, the snapshot is the one that the command makes with `--from-index`. With the index alone, an exported function is no entry point.
A Swift project needs the command: the page has no Swift parser, so it reads no bodies, and it does not know the products of a package.

The page offers this when its folder has `exporter.wasm`, which is the exporter as a WebAssembly program of about 54 MB (15 MB with Brotli):

    Wasm/build.sh <toolchain-bin> <sdk-bundle> <llvm-project> <work-dir> exporter.wasm
    flowgraph site --exporter exporter.wasm --out site

The script needs a swift.org toolchain, the Swift SDK for WebAssembly of the same release, a checkout of `swiftlang/llvm-project` of that release, and `cmake`.
It compiles the index reader of clang and the part of LLVM's support library that the reader needs, and links them into the exporter. The page opened from one file has no exporter.

## The page

- With no root, the graph offers the entry points of the project: one click draws all that an entry point reaches.
- Search (`/`) picks a root. Shift adds a second root.
- `callers` and `callees` set the depth on each side, up to `max`.
- Click a symbol: the panel lists who uses it, and what its body holds in the order of the source, each with file and line.
- Double-click a symbol to make it the root.
- The check boxes turn each kind of edge off, and hide data or types.
- Right-click a symbol, or press `h`, to hide it. All that only it led to goes with it, and the rest moves to its new place. The panel lists the hidden symbols, each with a switch to bring it back.
- Each row of the panel has a switch: `−` hides a shown symbol, `+` shows one that no depth reaches.
- `e` or "Expand neighbours" shows every caller, callee, and use of one symbol, whatever the depth.
- `limit` caps the drawn symbols of the graph, nearest to the root first. The status line says how many more are reachable.
- `Library` opens another snapshot.
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

`replace` holds the name of a module, or `Module.name` of a symbol, where the name of a member leads with its type: `SomeModule.SomeType.someMethod`.
The tool stops with a message when the file is not of this form.

## Compare two snapshots

The tool only exports. The page compares.

    flowgraph snapshot . --out head.json --html head.html
    flowgraph snapshot . --ref main --out base.json

Open `head.html`, press `Diff…`, drop `base.json` on the library, and press its `Base`. The open snapshot is the head. Both stay on this computer.
The two can be of two projects: the page then matches what has the same identity in both, and the rest is added or removed.

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

## The image

`mhehmsoth/swift-flowgraph:swift-6.4` holds the tool on the Swift 6.4 image for Linux, with the toolchain, so it builds a project and reads the index of that build.
The entry point of the image is `flowgraph`, and its working directory is `/work`.

    docker run --rm -v "$PWD:/work" --entrypoint swift mhehmsoth/swift-flowgraph:swift-6.4 build
    docker run --rm -v "$PWD:/work" mhehmsoth/swift-flowgraph:swift-6.4 snapshot . --out snapshot.json --html page.html

Build the project in the image, as the first line does: the index holds the full paths of the files, and the toolchain that wrote it reads it.
For the same reason, compare two snapshots of the same platform: the symbols of the dependencies and of the system differ between macOS and Linux.

`docker build -t flowgraph .` builds the image from this repository. The tag of the published image names the Swift version, because the index of a project is read by the toolchain that wrote it.

## In CI

A job builds the project in the image, writes the snapshot, and publishes the folder of `flowgraph site` on a static host.
This job is for GitHub Actions and GitHub Pages. It compares each run with the run before it, with one build:

    flowgraph:
      runs-on: ubuntu-24.04
      container:
        image: mhehmsoth/swift-flowgraph:swift-6.4
        credentials:                      # only when the image is private for you
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      steps:
        - uses: actions/checkout@v7
        - run: swift build
        - shell: bash
          run: |
            site="https://${GITHUB_REPOSITORY_OWNER}.github.io/${GITHUB_REPOSITORY#*/}"
            flowgraph site --out out
            flowgraph snapshot . --out out/head.json
            curl -fsSL "${site}/head.json" -o out/base.json || rm -f out/base.json
        - uses: actions/upload-pages-artifact@v5
          with:
            path: out

    pages:
      needs: flowgraph
      runs-on: ubuntu-24.04
      permissions: { pages: write, id-token: write }
      environment: github-pages
      steps:
        - uses: actions/deploy-pages@v5

The page is then at `…/index.html?snapshot=head.json`, and from the second run the comparison is at `…/index.html?snapshot=head.json&base=base.json&view=diff`.

- The base of that job is the run before, which is not always the commit before. For the base of a pull request, export it with `--ref`:
  `flowgraph snapshot . --ref origin/main --out out/base.json`. That is a second build, in a worktree under `~/.cache/flowgraph`, so cache that directory. `--ref` needs the history of the ref, so check out with `fetch-depth: 0`.
- A build of one product (`swift build --product <name>`) indexes the files of that product only. The snapshot holds those, and the tool notes how many files the build left out.
- A hosted page is as public as its host. The snapshot holds the names of the symbols and the first line of each statement.
- A job in a container needs what the build of the project needs: system packages, and the access to private dependencies.

## By entry point

An entry point is code that a caller outside the project starts:

- a function with `@_cdecl`, `@c`, or `@main`, or a C `main`;
- a C or C++ function that its binary exports (see "A C or C++ project");
- the top-level code of a `main.swift`;
- a function or a closure that the project hands to a function of a dependency, for example a handler that it registers. Its name is the call that takes it, with the literal arguments: `get("users") { }`. The standard library and the SDK do not count, so a closure for `map` is no entry point.

`entries.only` and `entries.except` of `flowgraph.json` hold patterns of `Module.name` for the functions of dependencies that make entry points. The name has no argument labels, and `*` stands for any text: `SomeModule.get` or `SomeModule.*`.
The rules are for the functions and closures that the project hands over. An entry point by an attribute or by `main.swift` stays.

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
| dispatch | an override, or the implementation of a protocol requirement: a call of the base can land here. Also from a field that holds a function to each function that the code stores in it |

## Add a view

The viewer is `Sources/flowgraph/web`:

| File | Content |
|---|---|
| `index.html` | The controls, the tabs, and one `<script>` line for each file below. |
| `model.js` | Reads a snapshot into the model that the views use. Its head documents the snapshot format and the types. |
| `core.js` | Holds the snapshot that is open and the state that all views share (roots, depths, filters, hidden symbols, the selection), and works out the scope: the symbols that the roots reach. |
| `view-graph.js` | The graph view. |
| `view-table.js` | The table view. |
| `view-trace.js` | The trace view. |
| `toolbar.js` | The search and the controls above the views. |
| `panel.js` | The side panel. |
| `diff.js` | The comparison of two snapshots: the merged model that every view reads. |
| `store.js` | The snapshots that the browser keeps. |
| `library.js` | The list of those snapshots, where one is opened or made the base. |
| `exporter.js`, `exporter-worker.js` | The snapshot from an index store: the worker runs `exporter.wasm` on the files of the picked folder. |
| `wasi.js` | What a WebAssembly program for WASI asks of its system, on files in memory. |
| `view-changes.js` | The summary of a diff. |

A view is one file that calls `FG.registerView`, and one `<script src>` line in `index.html` before the `FG.start` line:

    FG.registerView({
      id: 'list', title: 'List',
      mount(box, bar) { /* once: build the DOM inside box */ },
      update(scope) { /* after each change: scope.order is the shown symbols, nearest first */ },
      select(id, reveal) { /* the selection changed */ },
    });

`FG.model` holds the symbols (`N`), the edges (`E`), and the edges of each symbol (`out`, `inc`). `FG.body(id)` gives the outline of a body, `FG.exits(id)` its ways out, and `FG.isMarked(id)` the marks. With a base chosen, each symbol, edge, and step has a `diff` field, which `diff.js` documents. A view that does not read it shows both snapshots as one. `FG.state` is the shared state, and a view changes it with `FG.select`, `FG.setRoot`, `FG.hide`, `FG.show`, or by a write to `FG.state` and a call of `FG.refresh()`.
The head of `model.js` documents the snapshot format and the types.

## Limits

- The trace is for Swift. A C or C++ function has edges, and no outline.
- Local variables and parameters are not nodes.
- The index holds one record of a header for each context that compiled it: each C file that includes it, and the build of its module for Swift. The records are not the same: one can hold a macro that the other does not.
  The tool reads every record and joins them, so two builds of one tree give the same symbols. A snapshot of a version before this one read one record only, by an order that changed with the build directory: compared with a new snapshot, it shows symbols of headers as added.
- The link from a field to the function that it holds is read from the lines: a write of the field, and after it the name of a function, on one line, in one function. An assignment over two lines gives no link.
  A call between the two gives no link either, because the function is then an argument of the call: `table.frame = wrap(frame)` links nothing. A function that a `switch` reaches by a number leaves no trace in the index.
- A static library that is linked into two binaries is one binary of its own. A function that it calls and that each of the two binaries defines is then drawn as a symbol of another module, because the index does not say what is linked with what.
- The binary of a C file is read from the path of its object file. A build that puts the object files of two binaries into one directory gives one binary.
- A use inside a closure belongs to the function that holds the closure, unless the closure is an entry point.
- A callee of a dependency has no body in the snapshot, so a `try` of it counts as a place where an error can leave.
