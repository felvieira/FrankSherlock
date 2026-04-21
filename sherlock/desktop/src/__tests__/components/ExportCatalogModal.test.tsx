import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ExportCatalogModal from "../../components/modals/ExportCatalogModal";

const invokeMock = vi.fn();
const saveMock = vi.fn();
const openPathMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: unknown[]) => openPathMock(...args),
  openUrl: vi.fn(),
}));

describe("ExportCatalogModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    openPathMock.mockReset();
  });

  it("cancels when user dismisses the save dialog", async () => {
    saveMock.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<ExportCatalogModal onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("exports and surfaces the count and byte size", async () => {
    saveMock.mockResolvedValue("C:\\Users\\me\\catalog.zip");
    invokeMock.mockResolvedValue({ zipPath: "C:\\Users\\me\\catalog.zip", entries: 123, bytes: 4567890 });
    render(<ExportCatalogModal onClose={() => {}} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("export_catalog_cmd", { outZip: "C:\\Users\\me\\catalog.zip" })
    );
    await waitFor(() => expect(screen.getByText(/123/)).toBeInTheDocument());
    expect(screen.getByText(/4\.[0-9]+.*MB/i)).toBeInTheDocument(); // loose — formatBytes varies
  });

  it("shows error from backend", async () => {
    saveMock.mockResolvedValue("C:\\out.zip");
    invokeMock.mockRejectedValueOnce(new Error("refusing to overwrite existing file: C:\\out.zip"));
    render(<ExportCatalogModal onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/refusing to overwrite/i)
    );
  });

  it("opens containing folder when Open folder is clicked", async () => {
    saveMock.mockResolvedValue("C:\\Users\\me\\catalog.zip");
    invokeMock.mockResolvedValue({ zipPath: "C:\\Users\\me\\catalog.zip", entries: 5, bytes: 1024 });
    openPathMock.mockResolvedValue(undefined);
    render(<ExportCatalogModal onClose={() => {}} />);
    const btn = await screen.findByRole("button", { name: /open folder/i });
    await userEvent.click(btn);
    expect(openPathMock).toHaveBeenCalledWith("C:\\Users\\me");
  });
});
