import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import TagRulesModal from "../../components/modals/TagRulesModal";
import type { TagRule } from "../../types";

const mockedInvoke = vi.mocked(invoke);

const mockRule: TagRule = {
  id: 1,
  pattern: "^Screenshots/",
  tag: "screenshot",
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "list_tag_rules") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});

describe("TagRulesModal", () => {
  it("renders empty state when no rules", async () => {
    render(<TagRulesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.getByText("No rules yet")).toBeDefined();
  });

  it("renders existing rules from the backend", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "list_tag_rules") return Promise.resolve([mockRule]);
      return Promise.resolve(undefined);
    });
    render(<TagRulesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.getByText("^Screenshots/")).toBeDefined();
    expect(screen.getByText("screenshot")).toBeDefined();
  });

  it("adds a new rule when Add is clicked", async () => {
    const newRule: TagRule = { id: 2, pattern: "^Videos/", tag: "video", enabled: true };
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "list_tag_rules") return Promise.resolve([]);
      if (cmd === "create_tag_rule") return Promise.resolve(newRule);
      return Promise.resolve(undefined);
    });

    render(<TagRulesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    fireEvent.change(screen.getByPlaceholderText(/Regex pattern/), {
      target: { value: "^Videos/" },
    });
    fireEvent.change(screen.getByPlaceholderText("Tag"), {
      target: { value: "video" },
    });
    fireEvent.click(screen.getByText("Add"));

    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("create_tag_rule", {
        pattern: "^Videos/",
        tag: "video",
      })
    );
    await waitFor(() => expect(screen.getByText("^Videos/")).toBeDefined());
  });

  it("shows error for invalid regex", async () => {
    render(<TagRulesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    fireEvent.change(screen.getByPlaceholderText(/Regex pattern/), {
      target: { value: "[invalid(" },
    });
    fireEvent.change(screen.getByPlaceholderText("Tag"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByText("Add"));

    expect(screen.getByText("Invalid regex pattern")).toBeDefined();
  });

  it("deletes a rule when ✕ is clicked", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "list_tag_rules") return Promise.resolve([mockRule]);
      if (cmd === "delete_tag_rule") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    render(<TagRulesModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("^Screenshots/")).toBeDefined());

    fireEvent.click(screen.getByLabelText("Delete rule"));

    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("delete_tag_rule", { ruleId: 1 })
    );
    await waitFor(() => expect(screen.queryByText("^Screenshots/")).toBeNull());
  });

  it("calls onClose when Close is clicked", async () => {
    const onClose = vi.fn();
    render(<TagRulesModal onClose={onClose} />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
