import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import RemapRootModal from "../../components/modals/RemapRootModal";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const OLD_PATH = "D:\\Photos";
const NEW_PATH = "E:\\Photos";

function setInputValue(input: HTMLInputElement, value: string) {
  // React tracks the native value setter; overriding it ensures controlled
  // inputs register the change even when the string contains backslashes
  // (which can be mishandled by plain fireEvent.change in some scenarios).
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(input, value);
  fireEvent.input(input);
}

describe("RemapRootModal", () => {
  beforeEach(() => invokeMock.mockReset());

  it("submits old and new paths to remap_root_cmd and surfaces the count", async () => {
    invokeMock.mockResolvedValue({ rootsUpdated: 1, filesUpdated: 42, scanJobsUpdated: 1 });
    const onRemapped = vi.fn();
    render(<RemapRootModal oldPath={OLD_PATH} onClose={() => {}} onRemapped={onRemapped} />);

    const input = screen.getByLabelText(/new path/i) as HTMLInputElement;
    setInputValue(input, NEW_PATH);
    expect(input.value).toBe(NEW_PATH);
    fireEvent.click(screen.getByRole("button", { name: /remap/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("remap_root_cmd", {
        oldPath: OLD_PATH,
        newPath: NEW_PATH,
      })
    );
    expect(onRemapped).toHaveBeenCalledWith({ rootsUpdated: 1, filesUpdated: 42, scanJobsUpdated: 1 });
    await waitFor(() => expect(screen.getByText(/42 files updated/i)).toBeInTheDocument());
  });

  it("shows backend error and does NOT call onRemapped", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such root: D:\\Photos"));
    const onRemapped = vi.fn();
    render(<RemapRootModal oldPath={OLD_PATH} onClose={() => {}} onRemapped={onRemapped} />);

    const input = screen.getByLabelText(/new path/i) as HTMLInputElement;
    setInputValue(input, "Z:\\x");
    expect(input.value).toBe("Z:\\x");
    fireEvent.click(screen.getByRole("button", { name: /remap/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no such root/i));
    expect(onRemapped).not.toHaveBeenCalled();
  });

  it("disables remap button when new path equals old path", () => {
    render(<RemapRootModal oldPath={OLD_PATH} onClose={() => {}} onRemapped={() => {}} />);
    const btn = screen.getByRole("button", { name: /remap/i });
    expect(btn).toBeDisabled();
  });
});
