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
- The image workflow runs only on a push to `master`, and it publishes one image, `mhehmsoth/swift-flowgraph:swift-6.4`.
- No build in the browser. The viewer runs in the browser, and the export needs a compiler.

## Goal 1: the open work, in order

- [x] **A. The count of stale files.** Done, not committed. A file with no unit is stale only when it is newer than the index.
      The others are counted apart: the tool prints a note, and the snapshot holds `unindexedFiles`.
      Tested on the fixture: a build of one target gives 0 stale and 3 not in the index, and a touched file and a new file give 2 stale.
- [x] **B. README: the image and the use in CI.** Done, not committed. The sections "The image" and "In CI".
- [x] **C. Test `flowgraph.json`.** Done, not committed. `only`, `except`, the `*` pattern, and `replace` work on the fixture, and the page shows the marks.
      A file of a wrong form was ignored with no word. The tool now stops with a message. `Tests/fixture/check.sh` holds the case, and it passes in the image.
- [x] **D. Noise in the trace.** Done, not committed. The trace hides the calls that the compiler puts in for a literal and for a string with values in it,
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
4. **Bodies.** The outlines come from SwiftSyntax, so C and C++ have none, and the trace and the comparison of bodies are empty.
   libclang gives a real tree and comes with the toolchain. tree-sitter is lighter, and it does not expand macros.
5. **Macros.** 9,199 macro symbols with no edge to them make noise in the table.

## Goal 3: what is known

- The comparison in the browser takes two snapshot files and does not ask which exporter wrote them.
- The compiler identifiers of C and of Swift never agree, so the match must go by kind and name. A port that keeps the C names makes that plausible. It is untested.
- A comparison of bodies line by line has no meaning across two languages. The calls, the reads, and the writes of each function do.
- The summary must say ported, missing, or different, which is another view over the same merged model.
