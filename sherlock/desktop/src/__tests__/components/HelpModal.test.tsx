import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HelpModal from "../../components/modals/HelpModal";

describe("HelpModal", () => {
  it("renders the heading", () => {
    render(<HelpModal onClose={() => {}} />);
    expect(screen.getByText("Search help")).toBeInTheDocument();
  });

  it("shows example queries", () => {
    render(<HelpModal onClose={() => {}} />);
    expect(screen.getByText("anime ranma")).toBeInTheDocument();
    expect(screen.getByText("between 2023 and 2024")).toBeInTheDocument();
    expect(screen.getByText("album:vacation")).toBeInTheDocument();
  });

  it("shows camera, lens, and time filter examples", () => {
    render(<HelpModal onClose={() => {}} />);
    expect(screen.getByText("camera:Sony")).toBeInTheDocument();
    expect(screen.getByText("lens:50mm")).toBeInTheDocument();
    expect(screen.getByText("time:morning")).toBeInTheDocument();
  });

  it("calls onClose when Close button clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on backdrop click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
