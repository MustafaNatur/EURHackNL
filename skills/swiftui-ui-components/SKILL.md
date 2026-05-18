---
name: swiftui-ui-components
description: Guides iOS UI component architecture using SwiftUI—View, Layout, and Container patterns, Presentable for data, and separating state from presentation. Use when building or reviewing iOS SwiftUI views, UI components, screens, or when the user asks about iOS component structure, naming, state separation, or Presentable. Don't use for UIKit/AppKit views, Objective-C, data layer (networking, persistence, repositories), or non-SwiftUI projects.
---

# iOS UI Component Architecture

Follow these rules when implementing or reviewing SwiftUI UI components in iOS projects.

## When implementing a UI component

1. If the component has no state and only renders data — use a **View component** with a nested `Presentable`.
2. If the component arranges other views spatially — use a **Layout component** (view builders or `Layout` protocol).
3. If the component owns state or a view model lifecycle — use a **Container**.
4. Never put closures or display parameters inside `Presentable`; pass them as separate properties on the view.
5. If a Container drives a view model, pass view model methods as closures to the View; never pass the view model itself into the View.

## Naming

In SwiftUI everything is a View. Use suffixes to specialize:

| Suffix      | Meaning                         |
|------------|----------------------------------|
| **View**   | View component (stateless, pure) |
| **Layout** | Composes View components         |
| **Container** | Owns state / view model lifecycle |

## Separate state from presentation

View components without internal mutable state are easier to test (e.g. snapshots), debug, and maintain. Prefer View components that describe layout; keep state in Containers or view models.

## Separate data from configuration

Pass data via small **Presentable** types. Do **not** put in Presentable:

- **Closures** — they break automatic `Equatable` / `Hashable` for Presentable and encourage manual mistakes.
- **Display parameters** — they are component-specific and break Presentable universality; they also leak into view models.

Treat layout parameters, closures, and similar as **configuration** and pass them separately from Presentable.

---

## View component

A UI component with no internal state. Think of it as a pure function of `Presentable`.

- **Presentable** — nested type with all data needed to render.
- **Configuration** — layout params, closures, etc., passed separately.

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

---

## Layout component

Composes other View components. Either:

1. A view that takes **view builders** (e.g. `Cover`, `Title`, `Subtitle`), or  
2. A type conforming to the **Layout** protocol.

SwiftUI examples: `VStack`, `HStack`, `ZStack`. In this project: `EntityCardLayout`, `EntityRowLayout`, `EntityHeaderLayout`.

**Example — view builders:**

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

**Example — Layout protocol:** See the full `Layout` protocol implementation in [references/COMPONENTS.md](references/COMPONENTS.md#layout-component).

---

## Container component

Owns state and/or view model lifecycle. Composes View components and Layout components, feeding them Presentable data.

**Example — container with feature state and dependency:**

```swift
struct UserPlaylistsContainer: View {
    @Environment(\.libraryManager) var libraryManager
    @State var playlists: [Playlist] = []

    var body: some View {
        PlaylistsView(presentable: playlists)
            .task {
                playlists = await libraryManager.fetchUserPlaylists()
            }
    }
}
```

**Example — container with view builder (reusable fetch):**

```swift
struct UserPlaylistsContainer<Content: View>: View {
    typealias Fetch = () async throws -> [Playlist]
    @Environment(\.libraryManager) var libraryManager
    @ViewBuilder let content: (_ fetch: Fetch) -> Content

    var body: some View {
        content { try await libraryManager.fetchUserPlaylists() }
    }
}

// Usage
UserPlaylistsContainer { fetch in
    LoadableContainer(fetch) { phase in
        PlaylistsView(phase.value ?? .placeholder)
            .redacted(reason: phase.isLoading ? .placeholder : [])
    }
}
```

**Example — container with view model:**

```swift
struct UserPlaylistsContainer: View {
    @State var viewModel = UserPlaylistsViewModel()

    var body: some View {
        PlaylistsView(
            presentable: viewModel.playlists,
            onPlaylistTapped: viewModel.onPlaylistTapped,
            onRefreshRequested: viewModel.onRefreshRequested
        )
        .task { await viewModel.task() }
    }
}
```

The container owns the view model and bridges it to the View component by passing view model methods as closures. The View treats them as opaque signals — it does not know about the view model directly.

For the full ViewModel + Container + View component signals example, read [references/COMPONENTS.md](references/COMPONENTS.md#container-with-signals).

---

## Checklist when implementing or reviewing

- [ ] Views are stateless; state lives in Containers or ViewModels.
- [ ] Data is passed via Presentable; closures and display params are not inside Presentable.
- [ ] Naming uses View / Layout / Container suffixes consistently.
- [ ] Layouts only compose; they do not own business state.
- [ ] Containers handle dependencies (e.g. `@Environment`), `@State` (for `@Observable` view models), and lifecycle (e.g. `.task`).
- [ ] View model methods are passed as closures into component views; views never hold a reference to the view model directly.

---

For the full reference, see [references/COMPONENTS.md](references/COMPONENTS.md).
