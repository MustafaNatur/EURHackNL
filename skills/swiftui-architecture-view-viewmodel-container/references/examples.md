# Annotated Examples

Verbatim patterns extracted from production code. Copy the structure exactly.

---

## ViewModel

```swift
@MainActor
@Observable
final class ReceiptsViewModel {

    // ── State ──────────────────────────────────────────────────────────────
    enum State: Equatable {
        case loading
        case error(String)
        case loaded(ReceiptsView.Presentable)
    }

    private(set) var state: State = .loading

    // ── Navigation ─────────────────────────────────────────────────────────
    // Optional<Mode> drives .sheet(item:). Never use Bool for navigation.
    var sheetMode: ReceiptSheetMode?
    var showMap = false

    // ── Task lifecycle ─────────────────────────────────────────────────────
    // didSet cancels the in-flight task automatically.
    private var loadTask: Task<Void, Never>? {
        didSet { oldValue?.cancel() }
    }

    // Formatters are created once, not inside body or closures.
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; return f
    }()
    private let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    private let repository: any ReceiptRepository
    private var receipts: [Receipt] = []

    // Default argument → call site writes ReceiptsViewModel()
    init(repository: any ReceiptRepository = CoreDataReceiptRepository()) {
        self.repository = repository
    }

    // ── Load ───────────────────────────────────────────────────────────────
    // async because called from .task { await viewModel.load() }.
    // Sets .loading before fetching only on first load.
    func load() async {
        do {
            receipts = try await repository.fetchAll()
            applySort()                   // writes state = .loaded(…)
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────
    // Synchronous — finds domain model, updates navigation state.
    func onTapRow(_ row: ReceiptRowView.Presentable) {
        guard let receipt = receipts.first(where: { $0.id == row.id }) else { return }
        sheetMode = .existing(receipt)
    }

    // Synchronous public method, async work done inside Task.
    func deleteRow(_ row: ReceiptRowView.Presentable) {
        Task {
            guard let receipt = receipts.first(where: { $0.id == row.id }) else { return }
            do {
                try await repository.delete(id: receipt.id)
                receipts.removeAll { $0.id == receipt.id }
                applySort()
            } catch {
                state = .error(error.localizedDescription)
            }
        }
    }

    func onCloseSheet() {
        sheetMode = nil
        Task { await load() }
    }

    // ── Formatting ─────────────────────────────────────────────────────────
    // All string formatting lives here. View.body is purely declarative.
    private func makeRowPresentable(for receipt: Receipt) -> ReceiptRowView.Presentable {
        let totalString = currencyFormatter.string(
            from: NSDecimalNumber(decimal: receipt.total)
        ) ?? receipt.total.description

        return ReceiptRowView.Presentable(
            id: receipt.id,
            merchant: receipt.merchant.isEmpty ? "Unknown Merchant" : receipt.merchant,
            dateFormatted: dateFormatter.string(from: receipt.date),
            totalFormatted: "\(receipt.currency.rawValue) \(totalString)",
            category: receipt.category
        )
    }
}
```

---

## View + Presentable

```swift
struct ReceiptsView: View {

    // ── Presentable ────────────────────────────────────────────────────────
    // Nested inside the View it belongs to.
    // Equatable so Container can diff efficiently.
    struct Presentable: Equatable {
        struct Section: Equatable {
            let title: String
            let rows: [ReceiptRowView.Presentable]
        }
        let sections: [Section]
        var isEmpty: Bool { sections.allSatisfy { $0.rows.isEmpty } }
    }

    // ── Inputs ─────────────────────────────────────────────────────────────
    // Value types only. No @Binding, no ObservableObject.
    let presentable: Presentable
    let searchIsFocused: Bool

    // ── Callbacks ──────────────────────────────────────────────────────────
    // Plain non-async closures.
    let onTap: (ReceiptRowView.Presentable) -> Void
    let onDelete: (ReceiptRowView.Presentable) -> Void
    let onMapTap: () -> Void

    var body: some View {
        List {
            ForEach(presentable.sections, id: \.title) { section in
                Section(section.title) {
                    ForEach(section.rows) { row in
                        Button { onTap(row) } label: { ReceiptRowView(presentable: row) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) { onDelete(row) } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
            }
        }
    }
}
```

---

## Sub-view Presentable (row-level)

```swift
struct ReceiptRowView: View {

    // Presentable is nested, Identifiable + Hashable for use in ForEach.
    struct Presentable: Identifiable, Hashable {
        let id: UUID
        let merchant: String
        let dateFormatted: String   // pre-formatted by ViewModel
        let totalFormatted: String  // pre-formatted by ViewModel
        let category: ReceiptCategory
    }

    let presentable: Presentable

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            CategoryIconView(category: presentable.category)
            VStack(alignment: .leading, spacing: 3) {
                Text(presentable.merchant).font(.headline)
                Text(presentable.dateFormatted).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Text(presentable.totalFormatted).font(.title3).fontWeight(.semibold)
        }
        .padding(.vertical, 4)
    }
}
```

---

## Container

```swift
public struct ReceiptsContainer: View {

    // ViewModel is the ONLY @State.
    @State private var viewModel = ReceiptsViewModel()

    // @FocusState / @Namespace are the only other allowed property wrappers.
    @FocusState private var searchIsFocused
    @Namespace private var mapTransitionNamespace

    public init() {}

    public var body: some View {
        Group {
            switch viewModel.state {
            case .loading:
                ProgressView()
            case .error(let message):
                ContentUnavailableView(message, systemImage: "exclamationmark.triangle")
            case .loaded(let presentable):
                ReceiptsView(
                    presentable: presentable,
                    searchIsFocused: searchIsFocused,
                    onTap: viewModel.onTapRow,       // ViewModel method passed directly
                    onDelete: viewModel.deleteRow,
                    onMapTap: { viewModel.showMap = true }
                )
                .refreshable { await viewModel.load() }
            }
        }
        // All navigation modifiers here — never inside a View.
        .sheet(item: $viewModel.sheetMode) { mode in
            DetailContainer(mode: mode, onClose: viewModel.onCloseSheet)
        }
        .fullScreenCover(isPresented: $viewModel.showMap) {
            MapContainer()
                .navigationTransition(.zoom(sourceID: "map", in: mapTransitionNamespace))
        }
        .searchable(text: $viewModel.searchText, prompt: "Search")
        .searchFocused($searchIsFocused)
        .task { await viewModel.load() }   // no Task { } wrapper — direct call
    }
}
```

---

## Common mistakes

| Wrong | Correct |
|-------|---------|
| `@State var isLoading = false` + `@State var error: String?` | `enum State { case loading, error(String), loaded(…) }` |
| `Task { await viewModel.load() }` inside Container body | `.task { await viewModel.load() }` modifier |
| `DomainModel` passed to View | `View.Presentable` value type only |
| `Text(formatDate(item.date))` inside `body` | `presentable.dateFormatted` — already a `String` |
| `.sheet` inside a child View | `.sheet` only in Container |
| `NavigationStack` inside Container | `NavigationStack` at app entry-point |
| `@EnvironmentObject` | Pass via init or ViewModel default argument |
| `Task { }` in Container | Synchronous ViewModel method call |
