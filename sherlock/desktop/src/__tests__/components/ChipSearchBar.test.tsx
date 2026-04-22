import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ChipSearchBar from "../../components/Search/ChipSearchBar";

// Mock the api suggest call so TagAutocomplete doesn't hit Tauri
vi.mock("../../api", () => ({
  suggestTags: vi.fn().mockResolvedValue([]),
}));

describe("ChipSearchBar", () => {
  it("renders with placeholder when no query", () => {
    render(<ChipSearchBar query="" onQueryChange={() => {}} placeholder="Search…" />);
    expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
  });

  it("shows free text from initial query", () => {
    render(<ChipSearchBar query="beach sunset" onQueryChange={() => {}} />);
    expect(screen.getByDisplayValue("beach sunset")).toBeInTheDocument();
  });

  it("parses camera chip from initial query", () => {
    render(<ChipSearchBar query="camera:Sony beach" onQueryChange={() => {}} />);
    expect(screen.getByText("Sony")).toBeInTheDocument();
    expect(screen.getByText(/Camera/i)).toBeInTheDocument();
  });

  it("deletes a chip when × is clicked", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(<ChipSearchBar query='camera:"Canon R5"' onQueryChange={onQueryChange} />);
    const deleteBtn = screen.getByLabelText(/Remove camera filter/i);
    await user.click(deleteBtn);
    // After delete, the serialised query should not contain camera:
    const lastCall = onQueryChange.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).not.toContain("camera:");
  });

  it("opens facet menu when + button clicked", async () => {
    const user = userEvent.setup();
    render(<ChipSearchBar query="" onQueryChange={() => {}} />);
    await user.click(screen.getByLabelText("Add filter"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Camera" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Lens" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Time" })).toBeInTheDocument();
  });

  it("starts a pending chip when a facet is selected from menu", async () => {
    const user = userEvent.setup();
    render(<ChipSearchBar query="" onQueryChange={() => {}} />);
    await user.click(screen.getByLabelText("Add filter"));
    await user.click(screen.getByRole("menuitem", { name: "Camera" }));
    // A pending chip input should be visible
    expect(screen.getByLabelText(/camera filter value/i)).toBeInTheDocument();
  });

  it("emits serialized query when free text is typed", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    render(<ChipSearchBar query="" onQueryChange={onQueryChange} />);
    const input = screen.getByRole("searchbox");
    await user.type(input, "hello");
    // onQueryChange should have been called with the accumulated text
    const lastCall = onQueryChange.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toContain("hello");
  });
});
