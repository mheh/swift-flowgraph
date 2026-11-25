# Plan

This file records the goals of flowgraph, the work that is open, and what a trial on a C and C++ codebase found.
A box is ticked when the work is done and tested. The state of the commit is written beside it.

## Goals

1. **Now: flowgraph for Swift projects.** A generic tool that turns the compiler output of any Swift project into one web page.
   The page shows what uses what, who calls what, the function bodies with their ways out, and the difference between two commits.
   A project exports the snapshot in CI and reads it in the browser. The tool holds no knowledge of one project or one framework.
2. **Later: C and C++.** The tool also interprets C and C++ source files, so the same page works for a codebase in those languages.
   This goal is about reading the files of those languages. Where the tool then runs, and for which project, is a separate matter.
   Whether this is a new repository or a part of this one is open. Discuss it with the user before any work on it.
3. **Later still: a porting aid.** Compare the snapshot of a C original with the snapshot of its Swift port:
   which functions have a counterpart, which are missing, and where the call structure differs.
   It needs goal 2 first. It has no design yet, and it needs its own agreement with the user.

## The rule that keeps goals 2 and 3 possible

The snapshot format and the viewer hold no assumption that is true only for Swift.
The kinds and the edge kinds are the strings that the compiler gives. What is specific to Swift stays in the exporter:
the body outlines (SwiftSyntax), the products (SwiftPM), and the rules for entry points.

## Decisions that stand

- The edges come from the index store of the compiler. The tool reads no other code index. A symbol graph is optional and adds only declaration detail.
- The tool only exports. The comparison of two snapshots happens in the browser.
- For a comparison, export both sides in the same way and on the same platform.
- The workflow runs only on a push to `master`. It builds the tool once for each platform, and the one image, `mhehmsoth/swift-flowgraph:swift-6.4`, and the rolling `latest` release take the files of those builds.
- No build in the browser. The viewer runs in the browser, and the build that writes the index store needs a compiler.
  The export itself needs none: see "The exporter in the browser" below.

## Goal 1: the open work, in order

- [x] **A. The count of stale files.** Done. A file with no unit is stale only when it is newer than the index.
      The others are counted apart: the tool prints a note, and the snapshot holds `unindexedFiles`.
      Tested on the fixture: a build of one target gives 0 stale and 3 not in the index, and a touched file and a new file give 2 stale.
- [x] **B. README: the image and the use in CI.** Done. The sections "The image" and "In CI".
- [x] **C. Test `flowgraph.json`.** Done. `only`, `except`, the `*` pattern, and `replace` work on the fixture, and the page shows the marks.
      A file of a wrong form was ignored with no word. The tool now stops with a message. `Tests/fixture/check.sh` holds the case, and it passes in the image.
- [x] **D. Noise in the trace.** Done. The trace hides the calls that the compiler puts in for a literal and for a string with values in it,
      as it hides the operators. One function with 67 such sites went from 57 call boxes to 1.
- [ ] **E. The false status after a fast regroup.** Not reproduced in 48 fast regroups with a headless browser.
      One cause is closed by reading the code: the handler for a failed layout no longer writes over the status of a layout that ended. Not confirmed.
- [x] **F. The speed of the merge.** Measured with a real clock in a headless browser: about 0.45 s for 55,000 symbols, and 0.12 s for 21,000.
      A change of the side takes about 20 ms. No worker is necessary.
- [x] **G. Noise of C constants.** The cause is found, and README "Limits" holds it. No cure is in the tool.
      The index holds one record of a header for each context that compiled it: each C file that includes it, and the build of its module (`.pcm`).
      The records differ. In the trial, the record of a header from the module build had 0 macros, and the record from a C file had the macro.
      `symbolOccurrences(inFilePath:)` of the index reader gives the record of the first unit that holds the file, in the order of the unit codes of its database.
      The name of the `.pcm` unit differed between the two build trees, and all other unit names were the same. So the `.pcm` unit stood at another place, and another record came first.
      Measured: the same 75 units for the header in both trees, the C unit at place 74 in one and at place 1 in the other, 112 against 116 occurrences.
      Six fresh databases of one store gave the same result each time, so the order is fixed for one build.
      Not measured: that the unit code is a hash of the unit name. This is read from the source of the index reader.
      Possible cures, none decided: read each record of a header through the units and join them (the Swift API of the reader has no call for this, so it needs the C API or a fork);
      or leave out, in the comparison, an added or removed C symbol with no edge (it hides the true add of an unused macro).

Each of A to G ends with a build, the fixture check, and a headless test of the page where the page changed.

### Waits for something outside this repository

- [ ] **H. The diff on a hosted page with real data.** The page of the test project is published with no base yet.
      The first push of code to its `master` after 2026-11-24 gives the base. Then open the diff link and check it.
- [ ] **I. A second consumer on the 6.4 image.** A server project that builds on Swift 6.3 is untested in the image. It needs the word of the user, because the build is large.
- [ ] **J. A new image.** A fix of the exporter reaches the consumers only after a push to `master` here. Push only on the word of the user.

## Goal 2: what the trial on a C and C++ codebase found (2026-11-24)

The trial built the multiplayer side of a game engine of about 1,400 C and C++ files with CMake and the clang of the toolchain,
with `-index-store-path` added to `CMAKE_C_FLAGS` and `CMAKE_CXX_FLAGS`. The tool was not changed.

- All 559 compile commands passed with no change of the source, in 23 s. The snapshot took 5 s: 1,001 files, 42,754 symbols, 166,581 edges, 0 bodies.
- The clang of Xcode and the clang of the image `swift:6.4-noble` both take `-index-store-path`. The clang of upstream LLVM does not. The image has no `cmake`.
- The reader gives the symbols and the edges of C and C++ as it is: calls, reads and writes of fields, uses of types, methods of classes.

What is missing, in the order of its weight:

1. **One symbol for each binary.** C names a function by its name alone. Three modules each define an exported function of the same name, two programs each define `main`,
   and shared files are compiled once for each module. The snapshot merges them into one symbol, so a caller shows in the wrong file.
   The index records the output file of each unit, and the tool does not use it. The snapshot also shows one module, `C`, and no products.
2. **Calls through a function pointer.** The index holds both halves and no link between them:
   the caller calls a field of a struct, and another function writes the field and refers to the function that it stores.
   The edge kind `dispatch` exists for this link. The index alone links too much when one function fills more than one field; a parser of the body makes it exact.
   A dispatch by a number in a `switch`, reached by a looked-up symbol, leaves no trace in the index.
3. **Entry points.** Only `main` is marked. An exported function that nothing in the project calls is a candidate.
4. **Bodies.** The outlines come from SwiftSyntax, so C and C++ had none, and the trace and the comparison of bodies were empty. Step 5 below reads them from the text.
5. **Macros.** 9,199 macro symbols with no edge to them make noise in the table.

### Goal 2: the work

- [x] **1. One symbol for each binary.** Done. The exporter reads the index through its units and no longer through the database of the index reader.
      Since 2026-11-25 the tool does not link that database at all: the module of a symbol of another module comes from the record that declares it.
      A compilation with no module name gets the name of its binary from the path of its object file. A C function or variable that more than one binary defines has the binary in its key.
      Each binary is a module and a product of the type `binary`. A header that several binaries read is a module with the name of its directory.
      On the trial codebase: 9 binaries, 14 modules of shared headers, 39,886 symbols, 219,128 edges, in about 3 s.
      Not solved: a static library that two binaries link is a binary of its own, so its calls of a function that both binaries define stay with no target (8 call sites in the trial).
- [x] **2. Entry points and macros.** Done. A C function is an entry point when its binary exports it: the attribute on its line or on the line above, or a macro there that holds the attribute.
      The trial codebase has 14 (the exported functions of its three modules and of its two renderers, and three `main`). A first rule, "nothing in the project calls it", gave 1,350 and was dropped.
      A macro that nothing uses is left out.
- [x] **3. Function tables.** Done. A write of a field and the name of a function on one line give a `dispatch` edge from the field to the function.
      A field or a variable that the code calls has the kind `functionField` or `functionVariable`. On the trial codebase a path now goes from the frame function of the host, through the table, to the frame function of the module.
      A call between the write and the name ends the link. Without this rule, `handle = create(name, callback)` linked the handle to the callback,
      and in a comparison of the test project 917 symbols counted as affected by 4 changed bodies. With the rule it is 16.
- [x] **4. Every record of a header (the cure for G).** Done. It follows from the reader of step 1.
      Measured on the two build trees of G: the old tool gave 2 and 1 symbols that the other tree did not have; the new tool gives the same set of symbols for both.
- [x] **5. Bodies for C and C++.** Done, with a reader of the text and not with libclang.
      libclang needs the flags of each compilation and the headers of the build computer. The index does not hold the flags, so an index from another computer and the exporter in the page would have no bodies.
      The reader (`CTokens.swift`, `CBodies.swift`) splits the text into tokens and follows the braces and the keywords. What a step uses comes from the index by line and column, as for Swift, so a use inside a macro still lands on its step.
      Measured on the C test project: 15,361 of 16,084 functions have an outline; the other 723 are declarations with no body. 272,518 steps in about 2 s more.
      Of the calls, reads, and writes that the index has inside a body, all land on a step but 6, which are default values of parameters.
      Not checked by eye beyond some ten functions. Known wrong: a function whose braces come from a macro.

Checked for Swift: the fixture package gives the same snapshot from the old and from the new exporter, apart from the time. The test project of 2,205 files gives the same products and the same entry points;
its C symbols have other names and modules where the old reader gave none (a field now leads with its struct, and a header symbol has the module of its header).
A path with `..` in the index is resolved before the lookup: without this, 73 macros of a header that was included through `../` were read as symbols of a dependency.

## The exporter in the browser: what the trial found (2026-11-25)

The question was whether the page can read an index store itself, so that a user builds with one flag and gives the folder to the page.
The trial compiled the exporter of this repository to WebAssembly (WASI) and ran it in Node. Nothing of the trial is in the repository.

Measured:

- The index reader of the compiler (five source files of clang, and the support library of LLVM) compiles for WASI.
  It needs stand-ins for what WASI does not have: lock types, users, signals, processes, and a directory watcher. The reader calls none of them.
- The exporter compiles with the Swift SDK for WebAssembly, with the reader linked in and not loaded at run time.
- For the C and C++ trial codebase, the snapshot is the same as the native one apart from the commit, in 5.0 s against 4.3 s native.
- For the Swift test project, the symbols, the edges, and the 21,439 bodies are the same, in about 16 s against 12 s native.
- The program is 60 MB, and 20 MB compressed. A first test with only the parser and Foundation had the same size, so the reader adds little.

What the trial changed in the tool, because a number is 32 bits wide there: the hash of a step and the key of a place in a file have a fixed width now.
The native snapshots did not change.

What does not work there, and is not solved:

- No `git`, so the snapshot has no commit and no branch. The user would have to give them.
- No `swift package describe`, so a Swift package has no products, and a build directory with a suffix keeps the suffix in the name of its module.
  A build with no packages is not affected.
- `--ref` and the search for an index store need a process or the home directory.

Not tested: the program in a browser with a folder that the user picks, the memory that it needs, a store of several hundred MB,
a store that another version of the compiler wrote, and a store with compressed records (the trial left zlib out).

Decided by the user (2026-11-25): the page gets an exporter for the index store of a C or C++ build only.
A user builds with `-index-store-path` and gives the folder to the page. A Swift project keeps the command and gives the page the snapshot file.
So the program in the page needs no Swift parser and no package description. Its size without the parser is not measured yet.

### The page: the work, in order

- [x] **1. A library of snapshots in the storage of the browser** (IndexedDB): the name, the commit, the date, and the size of each; open and delete.
      Two snapshots of 25 MB and 8 MB go in within 0.5 s and take 15 MB of the storage. `Tests/page/check.sh` runs the test of it in headless Chrome.
- [x] **2. Head and base from the library**, also from two projects.
- [x] **3. A start screen** in place of the empty graph, and a review of the toolbar, the status line, and the empty states.
      With no root, the graph view offers the entry points. The toolbar has three groups: where the views start, what they hold, and the snapshots.
- [x] **4. `core.js` in parts**: `model.js` reads a snapshot, `core.js` holds the state and the comparison, `toolbar.js` and `panel.js` hold the controls. The storage is `store.js`.
      `Tests/page/controls.js` tests the controls, and it passed before and after the split.
- [x] **5. Speed, measured** on a Swift and on a C snapshot: load, first render, scroll of the table, change of the root.
      Measured in headless Chrome with `Tests/page/check.sh <flowgraph> <head.json> <base.json> speed`, on a Swift snapshot of 54,000 symbols and 311,000 edges (25 MB) and a C snapshot of 40,000 symbols and 219,000 edges (8 MB):

      | Step | Swift | C |
      |---|---|---|
      | Read the file and parse it | 0.17 s | 0.07 s |
      | Make the model | 0.07 s | 0.05 s |
      | Choose an entry point, to the drawn graph | 0.27 s (92 symbols reached) | 0.52 s (9,766 reached) |
      | Change the root | 0.39 s | 0.72 s |
      | Select a symbol | 0.03 s | 0.05 s |
      | Table, first render | 0.05 s | 0.03 s |
      | Table, one scroll step | 17 ms | 17 ms (worst 30 ms) |
      | Trace | 0.02 s | 0.02 s |
      | Choose a base, to the drawn diff | 0.39 s | 0.22 s |

      No step needs a change. The scope of 9,766 symbols takes 0.03 s; the rest of a root change is the graph library, which draws 300 symbols at most.
- [x] **6. The exporter in the page** for a C or C++ index store, with a folder that the user picks.
      `Wasm/build.sh` builds the exporter for WASI from the sources of the tool, without the Swift parser and without the commands that run a process: 54 MB, 19 MB with gzip, 15 MB with Brotli.
      `flowgraph site --exporter` puts it in the folder of the page. `wasi.js` gives the program the files of the picked folder from memory, in a worker.
      The command has `--from-index` for the same work on a disk: the files come from the index, and the root of the project from their paths.
      Measured in headless Chrome with `Tests/page/check.sh ... exporter`: an index of 2,377 files (44 MB) becomes an open snapshot of 43,000 symbols in 5.8 s. With `--sources`, the program gives the same snapshot as the command.
      Not tested: the folder chooser in a browser window (the test hands the files to `FGLibrary.addIndex`), browsers other than Chrome, an index of several hundred MB, an index with compressed records.

Each part ends with a headless test of the page.

## Goal 3: what is known

- The comparison in the browser takes two snapshot files and does not ask which exporter wrote them.
- The compiler identifiers of C and of Swift never agree, so the match must go by kind and name. A port that keeps the C names makes that plausible.
  Measured on the test pair, by the base name of each function alone: of 10,137 names of C functions, 6,283 have a Swift function of that name, and 5,655 have exactly one.
  In the binary that the port started with it is 2,883 of 3,257 functions. So the match by name is good enough to build on.
- A comparison of bodies line by line has no meaning across two languages. The calls, the reads, and the writes of each function do.
- The summary must say ported, missing, or different, which is another view over the same merged model.

### Done: the match by name (2026-11-25)

- [x] `across.js` pairs the symbols of two projects by name and class, and `diff.js` uses it when the two snapshots share less than half of their identities. No new view: the diff mode of the page shows it, with other labels.
- Measured on the test pair, the port as the head: 8,591 pairs by name. Of the callables of the base, 7,137 are only in the base, most of them in the client and the two renderers, which the port does not have. In the game binary it is 536 of 3,247.
- One module of the port can hold what several modules of the base have. With the rule that each module of the head goes with one module of the base, it was 6,850 pairs. Each symbol now takes the module of the base that holds the most pairs of its own module.
- Of the 6,609 pairs of callables, 1,626 do not call the same functions, and 4,983 do. No symbol is affected across two projects: with the rule of one project it was 3,582 of them, because almost every function reaches a symbol that only the port has.
- With reads and writes in the comparison only 375 pairs were the same, so they are left out.
- Two commits of the C test project, both built the same way: 109 added, 0 removed, 42 bodies changed, for a change of 15 files. With one side built with another define it was 340 bodies.
- `Changes` has one row for each module of the base, with its functions that have a pair, that call the same, and that the port does not have.
- Not done: a pair that the port renamed, and a summary for each file.

## Checked before the push (2026-11-25)

- The Linux image builds, and the fixture check passes in it, with the case of an index from another computer and the outline of the C fixture.
- The exporter for the page is built again from the current sources. On the index of the C test project it writes the same snapshot as the command.
- In the page, the exporter reads the bodies when the picked folder holds the sources: 11 bodies of the C fixture, and none with the index alone.
