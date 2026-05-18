---
name: swiftui-architecture-view-viewmodel-container
description: >-
  Builds SwiftUI features following an MVVM + Clean Architecture pattern:
  @Observable ViewModel with a State enum, stateless View with a nested
  Presentable struct, and a Container that owns the ViewModel. Use when
  creating a new screen, ViewModel, View, or Container in a SwiftUI iOS app.
  Do NOT use for UIKit-only projects, React Native, Flutter, or non-iOS targets.
---

# SwiftUI Feature Architecture

Read `references/examples.md` for full annotated code before writing any code.

## Layer summary

```
Container (@State ViewModel) ──► ViewModel (@Observable) ──► Service / Repository
     │                                   │
     └──► View(Presentable, callbacks)   └── formats dates / numbers for View
```

---

## Step 1 — ViewModel

File: `FeatureViewModel.swift` (internal, not `public`)

```swift
@MainActor
@Observable
final class FeatureViewModel {

    enum State: Equatable {
        case loading
        case error(String)
        case loaded(FeatureView.Presentable)
    }

    private(set) var state: State = .loading

    // One Optional<Mode> per sheet – never bare Bool flags for navigation
    var detailMode: DetailMode?

    // Cancels the previous task automatically on reassignment
    private var loadTask: Task<Void, Never>? {
        didSet { oldValue?.cancel() }
    }

    // Default argument lets callers write FeatureViewModel() with no arguments
    init(repository: any SomeRepository = ConcreteRepository()) { … }

    // Public trigger methods are SYNCHRONOUS – they spawn Tasks internally
    func load() {
        loadTask = Task {
            do {
                let items = try await repository.fetchAll()
                guard !Task.isCancelled else { return }
                state = .loaded(makePresentable(from: items))
            } catch {
                state = .error(error.localizedDescription)
            }
        }
    }

    func onTapRow(_ row: FeatureView.Presentable.Row) {
        guard let item = items.first(where: { $0.id == row.id }) else { return }
        detailMode = .existing(item)
    }

    func onCloseDetail() {
        detailMode = nil
        load()
    }

    // Formatting lives here, never in View.body
    private func makePresentable(from items: [Item]) -> FeatureView.Presentable { … }
}
```

Rules:
- `@MainActor @Observable final class` — always
- `state` is a single `enum State` — never multiple `Bool` flags
- `loadTask` `didSet` cancels the previous task
- Distinguish `load()` (shows `.loading`) from a silent `reload()` if needed
- `guard !Task.isCancelled else { return }` before every state write
- All date / number / string formatting done here

---

## Step 2 — View

File: `FeatureView.swift` (internal)

```swift
struct FeatureView: View {

    struct Presentable: Equatable {
        struct Row: Identifiable, Equatable { … }
        let rows: [Row]
    }

    // All data as value types — no domain models, no ObservableObject
    let presentable: Presentable

    // Plain non-async closure callbacks only
    let onTap: (Presentable.Row) -> Void
    let onDelete: (Presentable.Row) -> Void

    var body: some View { … }  // purely declarative, no logic
}
```

Rules:
- `Presentable` is a nested struct inside the View it belongs to
- Domain models never appear in View — only `Presentable` value types
- Zero mutable `@State` — Container owns all state
- Zero `Task { }` — ViewModel owns all async work
- Actions leave via plain, non-async closures (`onTap`, `onDelete`, etc.)

---

## Step 3 — Container

File: `FeatureContainer.swift` (`public`)

```swift
public struct FeatureContainer: View {

    // ViewModel is the ONLY @State.
    // @Environment(\.dismiss) and @Namespace are the only allowed exceptions.
    @State private var viewModel = FeatureViewModel()

    public init() {}

    public var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                ProgressView()
            case .error(let message):
                ErrorView(message: message)
            case .loaded(let presentable):
                FeatureView(
                    presentable: presentable,
                    onTap: viewModel.onTapRow,
                    onDelete: viewModel.deleteRow
                )
            }
        }
        // All .sheet / .fullScreenCover live here, never inside View
        .sheet(item: $viewModel.detailMode) { mode in
            DetailContainer(mode: mode, onClose: viewModel.onCloseDetail)
        }
        // Call ViewModel synchronously — no Task { } wrapper
        .task { viewModel.load() }
    }
}
```

Rules:
- `viewModel` is the **only** `@State`
- `.sheet` / `.fullScreenCover` belong here, never inside a View
- `NavigationStack` lives at the app entry-point, not inside a Container
- No `Task { }` wrappers — call synchronous ViewModel methods directly
- Minimum own UI — delegate rendering to stateless View components

---

## Checklist

- [ ] ViewModel is `@MainActor @Observable final class`
- [ ] Single `enum State` — no multiple `Bool` flags
- [ ] `loadTask` pattern — `didSet { oldValue?.cancel() }`
- [ ] Public methods are synchronous; Tasks are internal
- [ ] `guard !Task.isCancelled else { return }` before every state write
- [ ] View receives only `Presentable` — no domain models
- [ ] All callbacks are plain non-async closures
- [ ] Container is the only `public` type
- [ ] No `Task { }` in Container
- [ ] `.sheet` / `.fullScreenCover` are in Container only
- [ ] `NavigationStack` is NOT inside the Container

## Reference

- Full annotated examples → `references/examples.md`
