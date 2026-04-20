import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ImportCatalogModal from "../../components/modals/ImportCatalogModal";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: vi.fn(),
}));

describe("ImportCatalogModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
  });

  it("renders the confirm step with Cancel and Choose file buttons", () => {
    render(<ImportCatalogModal onClose={() => {}} />);
    expect(screen.getByText(/importing will restore a catalog bundle/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked on confirm step", async () => {
    const onClose = vi.fn();
    render(<ImportCatalogModal onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("stays on confirm step when user dismisses file picker", async () => {
    openMock.mockResolvedValue(null);
    render(<ImportCatalogModal onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /choose file/i }));
    // Returns to confirm step
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument()
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("picks a file, invokes import, and shows success UI", async () => {
    openMock.mockResolvedValue("C:\\Users\\me\\catalog.zip");
    invokeMock.mockResolvedValue({ entries: 77, bytes: 2048 });
    render(<ImportCatalogModal onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /choose file/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_catalog_cmd", { bundle: "C:\\Users\\me\\catalog.zip" })
    );
    await waitFor(() => expect(screen.getByText(/77/)).toBeInTheDocument());
    expect(screen.getByText(/restart recommended/i)).toBeInTheDocument();
  });

  it("surfaces the overwrite-refused error with a hint", async () => {
    openMock.mockResolvedValue("C:\\bundle.zip");
    invokeMock.mockRejectedValueOnce(
      new Error("refusing to overwrite existing catalog at C:\\cat\\db"),
    );
    render(<ImportCatalogModal onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /choose file/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/refusing to overwrite existing catalog/i),
    );
    expect(screen.getByText(/export or move the existing catalog first/i)).toBeInTheDocument();
  });
});
