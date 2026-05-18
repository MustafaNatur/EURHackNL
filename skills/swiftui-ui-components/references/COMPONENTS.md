# UI Component Architecture (reference)

Detailed reference for iOS SwiftUI View, Layout, and Container patterns. Source: `iOS/Docs/Components.md` in this repository.

## Core Principles

- Use SwiftUI for layout
- Reusable UI components
- Separate state from presentation
- Separate data from configuration

## Naming

In SwiftUI everything is a View, so we use suffixes in type names to specialize components:

- View - View component (stateless, pure)
- Layout - composes View components into a layout
- Container - container component

## Separate State from Presentation

A component without internal mutable state is easier to test with snapshots, simpler to debug and maintain. Therefore, we strive to separate components that describe layout from components that own state.

## Separate Data from Configuration

We pass data between components using small Presentable structures. In addition to data, many components require display parameters and closures for communication with the parent component. Sometimes it's tempting to put all of this in Presentable, but this shouldn't be done:
- the presence of closures breaks automatic synthesis of `Equatable`, `Hashable` protocol conformance for Presentable, and we don't want to implement them manually, as it's easy to make mistakes
- display parameters are often specific to a particular component and break the universality of `Presentable`, and they also start to propagate into view models

## View Component

This is a UI component without internal state.

`Presentable` - a nested type that describes all data necessary for rendering the UI.

Layout parameters, closures, and other parameters - we treat as configuration and pass to the component separately from `Presentable`.

A View component can be thought of as a pure function of `Presentable`.

Example:
```swift
struct UserNameView: View {

    struct Presentable {
        let username: String
    }

    let presentable: Presentable

    var body: some View {
        Text("Hello, \(presentable.username)!")
    }
}

struct ScreenHeaderView: View {
    struct Presentable {
        let username: UserNameView.Presentable
    }

    let presentable: Presentable
    let onTapUsername: () -> Void

    var body: some View {
        UserNameView(presentable: presentable.username)
            .onTapGesture(perform: onTapUsername)
    }
}
```

## Layout Component

A View component that is responsible for composing other View components on the screen.

Can be represented as a view that accepts a set of view builders or as a full implementation of the Layout protocol.

Examples in SwiftUI: VStack, HStack, ZStack

Examples in the project: EntityCardLayout, EntityRowLayout, EntityHeaderLayout

Example #1. View + view builders:

```swift
struct EntityCardLayout<Cover: View, Title: View, Subtitle: View>: View {

    let cover: () -> Cover
    let title: () -> Title
    let subtitle: () -> Subtitle

    var body: some View {
        VStack(spacing: 8) {
            cover()
            title()
            subtitle()
        }
    }
}
```

Example #2. Layout protocol implementation:

```swift
struct EntityCardLayout: Layout {
    struct Cache {
        let maxWidth: CGFloat
        let totalHeight: CGFloat
        let sizes: [CGSize]
    }

    func makeCache(subviews: Subviews) -> Cache {
        let sizes = subviews.map({
            $0.sizeThatFits(.unspecified)
        })
        return Cache(
            maxWidth: sizes.max(by: { $0.width < $1.width })?.width ?? .zero,
            totalHeight: sizes.reduce(0, { $0 + $1.height }),
            sizes: sizes
        )
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) -> CGSize {
        CGSize(
            width: cache.maxWidth,
            height: cache.totalHeight
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Cache
    ) {
        var offset: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(
                    x: bounds.midX,
                    y: bounds.minY + offset
                ),
                anchor: .center,
                proposal: proposal
            )
            offset += cache.sizes[index].height
        }
    }
}
```

## Container Component

In general, a container can be thought of as a function of other components.

We use this pattern to extract state from View components and to manage the view model lifecycle.

Example #1:

```swift
struct UserPlaylistsContainer: View {

    @Environment(\.libraryManager) var libraryManager /// dependencies

    @State var playlists: [Playlist] = [] /// feature state

    var body: some View {
        PlaylistsView(presentable: playlists) /// View component
            .task { /// feature lifecycle management
                playlists = await libraryManager.fetchUserPlaylists()
            }
    }
}
```

Example #2. The same, but more universal, thanks to using a view builder:

```swift
struct UserPlaylistsContainer<Content: View>: View {
    typealias Fetch = () async throws -> [Playlist]

    @Environment(\.libraryManager) var libraryManager

    @ViewBuilder
    let content: (_ fetch: Fetch) -> Content

    var body: some View {
        content({ try await libraryManager.fetchUserPlaylists() })
    }
}

// Usage
UserPlaylistsContainer { fetch in
    LoadableContainer(fetch) { phase in
        PlaylistsView(phase.value ?? .placeholder)
            .isRedacted(phase.isLoading)
    }
}
```

Example #3. Container with view model (`@Observable` + `@State`):

```swift
struct UserPlaylistsContainer: View {
    @State var viewModel = UserPlaylistsViewModel()

    var body: some View {
        PlaylistsView(presentable: viewModel.playlists)
            .task { await viewModel.task() }
    }
}
```

## Container with signals

The Container passes view model methods as closures into the View component. The View calls them when user interaction occurs — these are its signals back to the view model. The View never imports or references the view model type directly.

```swift
// ViewModel — owns business logic, exposes signals as methods
@Observable
final class UserPlaylistsViewModel {
    var playlists: [PlaylistRowView.Presentable] = []
    var isLoading = false

    func task() async {
        isLoading = true
        playlists = await PlaylistsService.fetchUserPlaylists()
            .map(PlaylistRowView.Presentable.init)
        isLoading = false
    }

    func onPlaylistTapped(id: Playlist.ID) {
        // navigate, play, etc.
    }

    func onRefreshRequested() async {
        await task()
    }
}

// Container — owns ViewModel lifecycle, feeds closures into the View component
struct UserPlaylistsContainer: View {
    @State var viewModel = UserPlaylistsViewModel()

    var body: some View {
        PlaylistsView(
            presentable: viewModel.playlists,
            isLoading: viewModel.isLoading,
            onPlaylistTapped: viewModel.onPlaylistTapped,
            onRefreshRequested: viewModel.onRefreshRequested
        )
        .task { await viewModel.task() }
    }
}

// View component — stateless, receives data + signals, knows nothing about ViewModel
struct PlaylistsView: View {
    struct Presentable {
        let id: Playlist.ID
        let title: String
        let trackCount: String
    }

    let presentable: [Presentable]
    let isLoading: Bool
    let onPlaylistTapped: (Playlist.ID) -> Void
    let onRefreshRequested: () async -> Void

    var body: some View {
        List(presentable, id: \.id) { item in
            PlaylistRowView(presentable: .init(title: item.title, trackCount: item.trackCount))
                .onTapGesture { onPlaylistTapped(item.id) }
        }
        .refreshable { await onRefreshRequested() }
        .redacted(reason: isLoading ? .placeholder : [])
    }
}
```

Key rules:

- The View accepts closures as plain `let` properties — never the ViewModel itself.
- The Container passes `viewModel.someMethod` directly; no wrapper closure needed unless the signature needs adapting.
- Closures are **not** inside `Presentable` — they are separate configuration properties on the view.
- This keeps the View fully testable with stub closures and previewable without a real ViewModel.
