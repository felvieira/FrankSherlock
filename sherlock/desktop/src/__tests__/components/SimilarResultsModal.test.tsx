import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SimilarResultsModal from "../../components/modals/SimilarResultsModal";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

describe("SimilarResultsModal", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes find_similar_cmd on mount and renders the results", async () => {
    invokeMock.mockResolvedValue([
      { fileId: 2, rootId: 1, relPath: "b.jpg", absPath: "D:/b.jpg", filename: "b.jpg",
        mediaType: "photo", description: "sunset", thumbPath: null, score: 0.97 },
      { fileId: 3, rootId: 1, relPath: "c.jpg", absPath: "D:/c.jpg", filename: "c.jpg",
        mediaType: "photo", description: "beach", thumbPath: null, score: 0.82 },
    ]);
    render(<SimilarResultsModal sourceFileId={1} sourceLabel="a.jpg" onClose={() => {}} />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("find_similar_cmd", {
        fileId: 1, limit: 20, minScore: 0.5,
      })
    );
    await waitFor(() => expect(screen.getByText("b.jpg")).toBeInTheDocument());
    expect(screen.getByText("c.jpg")).toBeInTheDocument();
    expect(screen.getByText(/97%/)).toBeInTheDocument();
    expect(screen.getByText(/82%/)).toBeInTheDocument();
  });

  it("shows empty state when no matches", async () => {
    invokeMock.mockResolvedValue([]);
    render(<SimilarResultsModal sourceFileId={1} sourceLabel="a.jpg" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no similar/i)).toBeInTheDocument());
  });

  it("surfaces backend errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no such file: 9999"));
    render(<SimilarResultsModal sourceFileId={9999} sourceLabel="missing" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/no such file/i));
  });
});
