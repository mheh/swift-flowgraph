# flowgraph with the Swift toolchain that built it: the full build, for a local `docker build .`.
# CI does not use this file. It compiles in the job, with a cached build tree, and packages with Dockerfile.ci.
# Keep the last stage the same as Dockerfile.ci, apart from where the files come from.
#
# The toolchain is in the image because a snapshot reads the index store of a build, and `--ref` runs that build.
# Use the image whose Swift version is the one that builds your project.
ARG SWIFT_IMAGE=swift:6.4-noble

FROM ${SWIFT_IMAGE} AS build
WORKDIR /workspace
COPY Package.swift Package.resolved ./
RUN swift package resolve
COPY Scripts/build-linux.sh Scripts/
COPY Sources Sources
RUN Scripts/build-linux.sh /out

FROM ${SWIFT_IMAGE}
# The page and its scripts are in the resources folder, which the tool finds beside its binary.
COPY --from=build /out/ /usr/local/bin/
# A project that CI checked out belongs to another user than the one of the container.
RUN git config --system --add safe.directory '*'
WORKDIR /work
ENTRYPOINT ["flowgraph"]
CMD ["--help"]
