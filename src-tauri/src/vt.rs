//! The terminal Keel keeps for every pane, in Rust, whether or not a window is
//! showing it.
//!
//! A webview's xterm is only a view. This is the copy that lasts: it is fed every
//! byte the PTY produces, so a pane can leave one window and open in another (or
//! in none) and come back with its screen, its scrollback and its modes intact.
//! It also answers the questions a program asks its terminal — cursor position,
//! device attributes — while no view is there to answer them.
//!
//! The live screen and a short stretch of history sit in an `alacritty_terminal`
//! grid, which costs about 24 bytes a cell. Older history is kept as rows of
//! already-encoded text, a few bytes a cell, because nothing but a replay or a
//! read will ever look at it again. Each archived row remembers whether it ran on
//! into the next, so a view at another width still rewraps it.
//!
//! A replay is plain VT: archived rows, then the grid, then the cursor and
//! modes. Writing it into a fresh xterm of the same size reproduces the pane.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, CursorStyle, NamedColor, Processor};
use serde::Serialize;

/// Rows of history a pane keeps in all, archive and grid together. Matches the
/// xterm views, so a pane that moves window does not lose any.
pub const SCROLLBACK: usize = 20_000;
/// History rows left in the grid after archiving. A resize reflows these.
const HOT_KEEP: usize = 256;
/// History rows the grid may gather before the oldest are archived.
const HOT_MAX: usize = 1_024;
/// Rows the agent-status reader looks at, from the bottom of the screen.
const SCREEN_ROWS: usize = 120;

#[derive(Clone, Copy)]
struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Events the grid raises while it parses, gathered and handed back by `feed`.
#[derive(Clone, Default)]
struct Listener(Arc<Mutex<Vec<Event>>>);

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        if let Ok(mut events) = self.0.lock() {
            events.push(event);
        }
    }
}

/// Things the bytes asked for, beyond drawing.
#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    /// Bytes the terminal owes the program: replies to its queries.
    Reply(String),
    /// OSC 0 / OSC 2.
    Title(String),
    /// OSC 7 (`ident` 7) or OSC 9 (`ident` 9), as xterm hands them to a handler:
    /// everything after the ident and its semicolon.
    Osc { ident: u8, data: String },
}

/// OSC sequences the grid does not keep, picked out of the same bytes.
#[derive(Default)]
struct OscTap {
    found: Vec<(u8, String)>,
}

impl alacritty_terminal::vte::Perform for OscTap {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some((ident, rest)) = params.split_first() else {
            return;
        };
        let ident = match *ident {
            b"7" => 7,
            b"9" => 9,
            _ => return,
        };
        let data = rest
            .iter()
            .map(|part| String::from_utf8_lossy(part))
            .collect::<Vec<_>>()
            .join(";");
        self.found.push((ident, data));
    }
}

/// One archived row: encoded cells, and whether it ran on into the next row.
struct Archived {
    bytes: Box<[u8]>,
    wrapped: bool,
}

/// What the agent-status reader needs from the screen. Same shape as the
/// frontend's `AgentScreen`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScreen {
    pub lines: Vec<String>,
    pub cursor_line: i32,
    pub truncated: bool,
}

pub struct Vt {
    term: Term<Listener>,
    events: Listener,
    parser: Processor,
    osc: alacritty_terminal::vte::Parser,
    archive: VecDeque<Archived>,
}

impl Vt {
    pub fn new(cols: u16, rows: u16) -> Self {
        let size = Size {
            cols: usize::from(cols.max(2)),
            rows: usize::from(rows.max(1)),
        };
        let events = Listener::default();
        let config = Config {
            // Large, so one big chunk of output cannot push rows out of the
            // grid before `archive` gets to them. They leave after each feed.
            scrolling_history: SCROLLBACK,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &size, events.clone()),
            events,
            parser: Processor::new(),
            osc: alacritty_terminal::vte::Parser::new(),
            archive: VecDeque::new(),
        }
    }

    pub fn size(&self) -> (u16, u16) {
        (
            self.term.columns().min(usize::from(u16::MAX)) as u16,
            self.term.screen_lines().min(usize::from(u16::MAX)) as u16,
        )
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Effect> {
        self.parser.advance(&mut self.term, bytes);
        let mut tap = OscTap::default();
        self.osc.advance(&mut tap, bytes);
        self.archive_history();

        let raised = std::mem::take(&mut *self.events.0.lock().unwrap_or_else(|p| p.into_inner()));
        let mut effects = Vec::new();
        for event in raised {
            match event {
                Event::PtyWrite(text) => effects.push(Effect::Reply(text)),
                Event::Title(title) => effects.push(Effect::Title(title)),
                _ => {}
            }
        }
        effects.extend(
            tap.found
                .into_iter()
                .map(|(ident, data)| Effect::Osc { ident, data }),
        );
        effects
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = Size {
            cols: usize::from(cols.max(2)),
            rows: usize::from(rows.max(1)),
        };
        if size.cols == self.term.columns() && size.rows == self.term.screen_lines() {
            return;
        }
        self.term.resize(size);
        self.archive_history();
    }

    /// Move the oldest grid history into the archive once there is enough of it.
    /// Only the main screen has history; the alternate screen never scrolls any.
    fn archive_history(&mut self) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }
        let history = self.term.grid().history_size();
        if history <= HOT_MAX {
            return;
        }
        let cols = self.term.columns();
        let grid = self.term.grid();
        for back in ((HOT_KEEP + 1)..=history).rev() {
            let row = &grid[Line(-(back as i32))];
            let wrapped = row_wraps(row, cols);
            let mut bytes = Vec::with_capacity(cols);
            encode_row(row, cols, !wrapped, &mut bytes);
            self.archive.push_back(Archived {
                bytes: bytes.into_boxed_slice(),
                wrapped,
            });
        }
        // The grid may gather up to `HOT_MAX` again before the next archive.
        while self.archive.len() > SCROLLBACK - HOT_MAX {
            self.archive.pop_front();
        }
        let grid = self.term.grid_mut();
        grid.update_history(HOT_KEEP);
        grid.update_history(SCROLLBACK);
    }

    /// VT that rebuilds this pane in a fresh terminal of the same size.
    pub fn replay(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            self.archive
                .iter()
                .map(|row| row.bytes.len() + 2)
                .sum::<usize>()
                + 64 * 1024,
        );
        let cols = self.term.columns();
        let rows = self.term.screen_lines();
        let grid = self.term.grid();
        let alt = self.term.mode().contains(TermMode::ALT_SCREEN);

        let mut lines: Vec<(Vec<u8>, bool)> = Vec::new();
        for row in &self.archive {
            lines.push((row.bytes.to_vec(), row.wrapped));
        }
        if alt {
            // The main screen's grid is out of reach while a program owns the
            // alternate one. Its archive is not; the program's screen goes on top.
            write_lines(&mut out, &lines, true);
            out.extend_from_slice(b"\x1b[?1049h\x1b[H");
            lines.clear();
        }
        let top = if alt {
            0
        } else {
            -(grid.history_size() as i32)
        };
        for line in top..rows as i32 {
            let row = &grid[Line(line)];
            let wrapped = row_wraps(row, cols);
            let mut bytes = Vec::with_capacity(cols);
            encode_row(row, cols, !wrapped, &mut bytes);
            lines.push((bytes, wrapped));
        }
        write_lines(&mut out, &lines, false);

        let cursor = grid.cursor.point;
        out.extend_from_slice(
            format!("\x1b[{};{}H", cursor.line.0.max(0) + 1, cursor.column.0 + 1).as_bytes(),
        );
        self.write_modes(&mut out);
        let pen = Pen::of(&grid.cursor.template);
        if pen != Pen::default() {
            pen.write(&mut out);
        }
        out
    }

    fn write_modes(&self, out: &mut Vec<u8>) {
        let mode = *self.term.mode();
        let mut set = |on: bool, code: &[u8]| {
            if on {
                out.extend_from_slice(code);
            }
        };
        set(!mode.contains(TermMode::SHOW_CURSOR), b"\x1b[?25l");
        set(mode.contains(TermMode::APP_CURSOR), b"\x1b[?1h");
        set(mode.contains(TermMode::APP_KEYPAD), b"\x1b=");
        set(mode.contains(TermMode::BRACKETED_PASTE), b"\x1b[?2004h");
        set(mode.contains(TermMode::MOUSE_REPORT_CLICK), b"\x1b[?1000h");
        set(mode.contains(TermMode::MOUSE_DRAG), b"\x1b[?1002h");
        set(mode.contains(TermMode::MOUSE_MOTION), b"\x1b[?1003h");
        set(mode.contains(TermMode::SGR_MOUSE), b"\x1b[?1006h");
        set(mode.contains(TermMode::UTF8_MOUSE), b"\x1b[?1005h");
        set(mode.contains(TermMode::FOCUS_IN_OUT), b"\x1b[?1004h");
        set(!mode.contains(TermMode::LINE_WRAP), b"\x1b[?7l");
        set(mode.contains(TermMode::INSERT), b"\x1b[4h");
        set(mode.contains(TermMode::LINE_FEED_NEW_LINE), b"\x1b[20h");
        let style = self.term.cursor_style();
        if style != CursorStyle::default() {
            if let Some(code) = cursor_code(style) {
                out.extend_from_slice(format!("\x1b[{code} q").as_bytes());
            }
        }
    }

    /// The bottom of the screen as the agent-status reader sees it: soft-wrapped
    /// rows joined, trailing blanks dropped, and which line the cursor is on.
    pub fn agent_screen(&self) -> AgentScreen {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let first = rows.saturating_sub(SCREEN_ROWS);
        let cursor = grid.cursor.point.line.0;
        let mut lines: Vec<String> = Vec::new();
        let mut cursor_line = -1;
        for row in first..rows {
            let text = row_text(&grid[Line(row as i32)], cols, false);
            let continues = row > first && row_wraps(&grid[Line(row as i32 - 1)], cols);
            match lines.last_mut() {
                Some(last) if continues => last.push_str(&text),
                _ => lines.push(text),
            }
            if row as i32 == cursor {
                cursor_line = lines.len() as i32 - 1;
            }
        }
        AgentScreen {
            lines: lines
                .iter()
                .map(|line| line.trim_end().to_string())
                .collect(),
            cursor_line,
            truncated: first > 0,
        }
    }

    /// The last `lines` rows of the active buffer as plain text, each trimmed on
    /// the right and trailing blank rows dropped — what the main agent reads.
    pub fn text(&self, lines: usize) -> String {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let alt = self.term.mode().contains(TermMode::ALT_SCREEN);
        let wanted = lines + rows;
        let mut out: VecDeque<String> = VecDeque::new();
        let top = if alt {
            0
        } else {
            -(grid.history_size() as i32)
        };
        for line in (top..rows as i32).rev() {
            if out.len() >= wanted {
                break;
            }
            out.push_front(row_text(&grid[Line(line)], cols, true));
        }
        if !alt {
            for row in self.archive.iter().rev() {
                if out.len() >= wanted {
                    break;
                }
                out.push_front(plain(&row.bytes).trim_end().to_string());
            }
        }
        while out.back().is_some_and(|row| row.trim().is_empty()) {
            out.pop_back();
        }
        let skip = out.len().saturating_sub(lines);
        out.into_iter().skip(skip).collect::<Vec<_>>().join("\n")
    }

    /// Bracketed when the program asked for it, with newlines as Enter — what
    /// xterm's `paste` sends, for panes no window is showing.
    pub fn paste_bytes(&self, text: &str) -> String {
        let text = text.replace("\r\n", "\r").replace('\n', "\r");
        if self.term.mode().contains(TermMode::BRACKETED_PASTE) {
            format!("\x1b[200~{text}\x1b[201~")
        } else {
            text
        }
    }
}

fn cursor_code(style: CursorStyle) -> Option<u8> {
    let steady = u8::from(!style.blinking);
    match style.shape {
        CursorShape::Block => Some(1 + steady),
        CursorShape::Underline => Some(3 + steady),
        CursorShape::Beam => Some(5 + steady),
        _ => None,
    }
}

/// Rows joined the way a terminal would print them: a row that ran on is
/// followed straight by the next, others by CR LF. `trailing` adds one after
/// the last row too. A run-on row whose continuation is empty gets a CR LF
/// anyway — printing nothing would not move the cursor to that row.
fn write_lines(out: &mut Vec<u8>, lines: &[(Vec<u8>, bool)], trailing: bool) {
    for (index, (bytes, wrapped)) in lines.iter().enumerate() {
        out.extend_from_slice(bytes);
        let next = lines.get(index + 1);
        let joined = *wrapped && next.is_some_and(|(bytes, _)| !bytes.is_empty());
        if next.is_some() {
            if !joined {
                out.extend_from_slice(b"\r\n");
            }
        } else if trailing {
            out.extend_from_slice(b"\r\n");
        }
    }
}

fn row_wraps(row: &Row<Cell>, cols: usize) -> bool {
    cols > 0 && row[Column(cols - 1)].flags.contains(Flags::WRAPLINE)
}

/// A cell that shows nothing: no glyph, no colour behind it, no line through it.
fn blank(cell: &Cell) -> bool {
    cell.c == ' '
        && cell.bg == Color::Named(NamedColor::Background)
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        && cell.hyperlink().is_none()
}

fn row_text(row: &Row<Cell>, cols: usize, trim: bool) -> String {
    let mut text = String::with_capacity(cols);
    for col in 0..cols {
        let cell = &row[Column(col)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        text.push(cell.c);
        if let Some(marks) = cell.zerowidth() {
            text.extend(marks);
        }
    }
    if trim {
        text.truncate(text.trim_end().len());
    }
    text
}

/// Text with the escapes `encode_row` writes taken out.
fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: up to ST.
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The attributes one cell is drawn with — everything SGR and OSC 8 can say.
#[derive(Clone, PartialEq, Eq)]
struct Pen {
    fg: Color,
    bg: Color,
    underline: Option<Color>,
    flags: Flags,
    link: Option<(String, String)>,
}

impl Default for Pen {
    fn default() -> Self {
        Self {
            fg: Color::Named(NamedColor::Foreground),
            bg: Color::Named(NamedColor::Background),
            underline: None,
            flags: Flags::empty(),
            link: None,
        }
    }
}

const STYLE_FLAGS: Flags = Flags::from_bits_truncate(
    Flags::INVERSE.bits()
        | Flags::BOLD.bits()
        | Flags::ITALIC.bits()
        | Flags::DIM.bits()
        | Flags::HIDDEN.bits()
        | Flags::STRIKEOUT.bits()
        | Flags::ALL_UNDERLINES.bits(),
);

impl Pen {
    fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            underline: cell.underline_color(),
            flags: cell.flags & STYLE_FLAGS,
            link: cell
                .hyperlink()
                .map(|link| (link.id().to_string(), link.uri().to_string())),
        }
    }

    /// SGR from a clean slate, so a row never depends on the one before it.
    fn write(&self, out: &mut Vec<u8>) {
        let mut sgr = String::from("\x1b[0");
        let flags = self.flags;
        if flags.contains(Flags::BOLD) {
            sgr.push_str(";1");
        }
        if flags.contains(Flags::DIM) {
            sgr.push_str(";2");
        }
        if flags.contains(Flags::ITALIC) {
            sgr.push_str(";3");
        }
        if flags.contains(Flags::DOUBLE_UNDERLINE) {
            sgr.push_str(";4:2");
        } else if flags.contains(Flags::UNDERCURL) {
            sgr.push_str(";4:3");
        } else if flags.contains(Flags::DOTTED_UNDERLINE) {
            sgr.push_str(";4:4");
        } else if flags.contains(Flags::DASHED_UNDERLINE) {
            sgr.push_str(";4:5");
        } else if flags.contains(Flags::UNDERLINE) {
            sgr.push_str(";4");
        }
        if flags.contains(Flags::INVERSE) {
            sgr.push_str(";7");
        }
        if flags.contains(Flags::HIDDEN) {
            sgr.push_str(";8");
        }
        if flags.contains(Flags::STRIKEOUT) {
            sgr.push_str(";9");
        }
        push_color(&mut sgr, self.fg, 30, 90, 38);
        push_color(&mut sgr, self.bg, 40, 100, 48);
        if let Some(color) = self.underline {
            push_color(&mut sgr, color, 0, 0, 58);
        }
        sgr.push('m');
        out.extend_from_slice(sgr.as_bytes());
    }
}

fn push_color(sgr: &mut String, color: Color, base: u8, bright: u8, extended: u8) {
    use std::fmt::Write as _;
    match color {
        Color::Named(name) => {
            let index = match name as usize {
                index @ 0..=15 => Some(index as u8),
                _ => match name {
                    NamedColor::DimBlack => Some(0),
                    NamedColor::DimRed => Some(1),
                    NamedColor::DimGreen => Some(2),
                    NamedColor::DimYellow => Some(3),
                    NamedColor::DimBlue => Some(4),
                    NamedColor::DimMagenta => Some(5),
                    NamedColor::DimCyan => Some(6),
                    NamedColor::DimWhite => Some(7),
                    _ => None,
                },
            };
            match index {
                // SGR 58 has no short form.
                Some(index) if base == 0 => {
                    let _ = write!(sgr, ";{extended};5;{index}");
                }
                Some(index @ 0..=7) => {
                    let _ = write!(sgr, ";{}", base + index);
                }
                Some(index) => {
                    let _ = write!(sgr, ";{}", bright + index - 8);
                }
                None => {}
            }
        }
        Color::Indexed(index) => {
            let _ = write!(sgr, ";{extended};5;{index}");
        }
        Color::Spec(rgb) => {
            let _ = write!(sgr, ";{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
}

/// One row as VT. `trim` drops trailing cells that show nothing; a row that runs
/// on into the next keeps all of them, because they are part of the text.
fn encode_row(row: &Row<Cell>, cols: usize, trim: bool, out: &mut Vec<u8>) {
    let end = if trim {
        (0..cols)
            .rev()
            .find(|&col| !blank(&row[Column(col)]))
            .map_or(0, |col| col + 1)
    } else {
        cols
    };
    let plain_pen = Pen::default();
    let mut pen = Pen::default();
    let mut utf8 = [0u8; 4];
    for col in 0..end {
        let cell = &row[Column(col)];
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        // Most cells are drawn exactly like the one before them. Say so without
        // building a pen.
        let same = cell.extra.is_none()
            && pen.underline.is_none()
            && pen.link.is_none()
            && cell.fg == pen.fg
            && cell.bg == pen.bg
            && cell.flags & STYLE_FLAGS == pen.flags;
        if same {
            if cell.c.is_ascii() {
                out.push(cell.c as u8);
            } else {
                out.extend_from_slice(cell.c.encode_utf8(&mut utf8).as_bytes());
            }
            continue;
        }
        let next = Pen::of(cell);
        if next != pen {
            if next.link != pen.link {
                match &next.link {
                    Some((id, uri)) => {
                        out.extend_from_slice(format!("\x1b]8;id={id};{uri}\x1b\\").as_bytes())
                    }
                    None => out.extend_from_slice(b"\x1b]8;;\x1b\\"),
                }
            }
            let mut style = next.clone();
            style.link = None;
            let mut previous = pen.clone();
            previous.link = None;
            if style != previous {
                style.write(out);
            }
            pen = next;
        }
        out.extend_from_slice(cell.c.encode_utf8(&mut utf8).as_bytes());
        if let Some(marks) = cell.zerowidth() {
            for mark in marks {
                out.extend_from_slice(mark.encode_utf8(&mut utf8).as_bytes());
            }
        }
    }
    if pen.link.is_some() {
        out.extend_from_slice(b"\x1b]8;;\x1b\\");
    }
    let mut style = pen;
    style.link = None;
    if style != plain_pen {
        out.extend_from_slice(b"\x1b[0m");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(vt: &mut Vt, text: &str) -> Vec<Effect> {
        vt.feed(text.as_bytes())
    }

    /// Replay into a second emulator and compare what both would show.
    fn round_trip(vt: &Vt) -> Vt {
        let (cols, rows) = vt.size();
        let mut copy = Vt::new(cols, rows);
        copy.feed(&vt.replay());
        copy
    }

    #[test]
    fn a_replay_reproduces_the_screen_and_cursor() {
        let mut vt = Vt::new(20, 4);
        feed(&mut vt, "one\r\n\x1b[1;31mtwo\x1b[0m\r\nthree");
        let copy = round_trip(&vt);
        assert_eq!(copy.agent_screen(), vt.agent_screen());
        assert_eq!(copy.term.grid().cursor.point, vt.term.grid().cursor.point);
        let cell = &copy.term.grid()[Line(1)][Column(0)];
        assert!(cell.flags.contains(Flags::BOLD));
        assert_eq!(cell.fg, Color::Named(NamedColor::Red));
    }

    #[test]
    fn a_replay_carries_history_through_the_archive() {
        let mut vt = Vt::new(10, 3);
        for n in 0..3_000 {
            feed(&mut vt, &format!("line {n}\r\n"));
        }
        assert!(!vt.archive.is_empty());
        assert!(vt.term.grid().history_size() <= HOT_MAX);
        let text = vt.text(5_000);
        assert!(text.starts_with("line 0\n"));
        assert!(text.ends_with("line 2999"));

        let copy = round_trip(&vt);
        assert_eq!(copy.text(5_000), text);
    }

    #[test]
    fn the_archive_is_capped_at_the_scrollback() {
        let mut vt = Vt::new(10, 2);
        for n in 0..(SCROLLBACK + 2_000) {
            feed(&mut vt, &format!("{n}\r\n"));
        }
        let kept = vt.archive.len() + vt.term.grid().history_size();
        assert!(kept <= SCROLLBACK, "{kept} rows of history");
        assert!(vt.text(SCROLLBACK + 10).lines().next().unwrap() != "0");
    }

    #[test]
    fn a_run_on_row_stays_one_line_after_replay() {
        let mut vt = Vt::new(8, 3);
        feed(&mut vt, "abcdefghijkl\r\n");
        let screen = vt.agent_screen();
        assert_eq!(screen.lines[0], "abcdefghijkl");
        let copy = round_trip(&vt);
        assert_eq!(copy.agent_screen(), screen);
    }

    #[test]
    fn the_alternate_screen_comes_back_on_top_of_the_main_one() {
        let mut vt = Vt::new(12, 3);
        feed(&mut vt, "shell$ \x1b[?1049h\x1b[Htui frame");
        let copy = round_trip(&vt);
        assert!(copy.term.mode().contains(TermMode::ALT_SCREEN));
        assert_eq!(copy.agent_screen().lines[0], "tui frame");
    }

    #[test]
    fn modes_a_program_set_survive_a_replay() {
        let mut vt = Vt::new(10, 2);
        feed(
            &mut vt,
            "\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[?1006h\x1b[?1000h",
        );
        let copy = round_trip(&vt);
        let mode = *copy.term.mode();
        assert!(mode.contains(TermMode::BRACKETED_PASTE));
        assert!(mode.contains(TermMode::APP_CURSOR));
        assert!(!mode.contains(TermMode::SHOW_CURSOR));
        assert!(mode.contains(TermMode::SGR_MOUSE));
        assert!(mode.contains(TermMode::MOUSE_REPORT_CLICK));
    }

    #[test]
    fn colours_and_wide_characters_survive_a_replay() {
        let mut vt = Vt::new(12, 2);
        feed(
            &mut vt,
            "\x1b[38;2;1;2;3;48;5;200mrgb\x1b[0m 你好 \x1b[4:3mcurl\x1b[0m",
        );
        let copy = round_trip(&vt);
        for col in 0..12 {
            let a = &vt.term.grid()[Line(0)][Column(col)];
            let b = &copy.term.grid()[Line(0)][Column(col)];
            assert_eq!(
                (a.c, a.fg, a.bg, a.flags),
                (b.c, b.fg, b.bg, b.flags),
                "col {col}"
            );
        }
    }

    #[test]
    fn a_coloured_background_is_not_trimmed() {
        let mut vt = Vt::new(10, 2);
        feed(&mut vt, "\x1b[44m          \x1b[0m");
        let copy = round_trip(&vt);
        assert_eq!(
            copy.term.grid()[Line(0)][Column(9)].bg,
            Color::Named(NamedColor::Blue)
        );
    }

    #[test]
    fn links_survive_a_replay() {
        let mut vt = Vt::new(20, 2);
        feed(
            &mut vt,
            "\x1b]8;id=a;https://x.test\x1b\\link\x1b]8;;\x1b\\ text",
        );
        let copy = round_trip(&vt);
        let link = copy.term.grid()[Line(0)][Column(0)].hyperlink().unwrap();
        assert_eq!(link.uri(), "https://x.test");
        assert!(copy.term.grid()[Line(0)][Column(5)].hyperlink().is_none());
    }

    #[test]
    fn queries_are_answered_as_replies() {
        let mut vt = Vt::new(10, 4);
        let effects = feed(&mut vt, "ab\x1b[6n");
        assert_eq!(effects, vec![Effect::Reply("\x1b[1;3R".into())]);
    }

    #[test]
    fn titles_and_folder_reports_are_picked_out() {
        let mut vt = Vt::new(10, 2);
        let effects = feed(
            &mut vt,
            "\x1b]0;my title\x07\x1b]9;9;C:\\code\\keel\x1b\\\x1b]7;file://host/tmp\x07",
        );
        assert_eq!(
            effects,
            vec![
                Effect::Title("my title".into()),
                Effect::Osc {
                    ident: 9,
                    data: "9;C:\\code\\keel".into()
                },
                Effect::Osc {
                    ident: 7,
                    data: "file://host/tmp".into()
                },
            ]
        );
    }

    #[test]
    fn a_report_split_across_chunks_is_still_found() {
        let mut vt = Vt::new(10, 2);
        assert!(feed(&mut vt, "\x1b]7;file://ho").is_empty());
        assert_eq!(
            feed(&mut vt, "st/a\x07"),
            vec![Effect::Osc {
                ident: 7,
                data: "file://host/a".into()
            }]
        );
    }

    #[test]
    fn the_agent_screen_joins_soft_wraps_and_finds_the_cursor() {
        let mut vt = Vt::new(5, 4);
        feed(&mut vt, "esc to\r\n> ");
        let screen = vt.agent_screen();
        assert_eq!(screen.lines[0], "esc to");
        assert_eq!(screen.lines[1], ">");
        assert_eq!(screen.cursor_line, 1);
        assert!(!screen.truncated);
    }

    #[test]
    fn text_skips_trailing_blank_rows() {
        let mut vt = Vt::new(10, 5);
        feed(&mut vt, "a\r\nb\r\n");
        assert_eq!(vt.text(10), "a\nb");
        assert_eq!(vt.text(1), "b");
    }

    #[test]
    fn a_paste_is_bracketed_only_when_asked_for() {
        let mut vt = Vt::new(10, 2);
        assert_eq!(vt.paste_bytes("a\nb"), "a\rb");
        feed(&mut vt, "\x1b[?2004h");
        assert_eq!(vt.paste_bytes("a"), "\x1b[200~a\x1b[201~");
    }

    #[test]
    fn plain_strips_what_encode_writes() {
        assert_eq!(
            plain(b"\x1b[0;1;38;2;1;2;3mhi\x1b[0m \x1b]8;id=a;u\x1b\\x\x1b]8;;\x1b\\"),
            "hi x"
        );
    }

    #[test]
    fn a_resize_keeps_the_grid_in_step() {
        let mut vt = Vt::new(10, 3);
        vt.resize(40, 12);
        assert_eq!(vt.size(), (40, 12));
        let copy = round_trip(&vt);
        assert_eq!(copy.size(), (40, 12));
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// `cargo test --release --lib vt::bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn throughput() {
        let mut frame = String::new();
        for n in 0..40 {
            frame.push_str(&format!(
                "\x1b[{};1H\x1b[2K\x1b[38;5;{}m│ ✻ Working… line {n} of a redraw with some text\x1b[0m",
                n % 40 + 1,
                n % 200
            ));
        }
        let scroll =
            "\x1b[32m+\x1b[0m added a line of a diff that scrolls the history up\r\n".repeat(200);
        let mut vt = Vt::new(160, 48);
        let started = std::time::Instant::now();
        let mut bytes = 0usize;
        let only = std::env::var("VT_BENCH").unwrap_or_default();
        for _ in 0..2_000 {
            if only != "scroll" {
                vt.feed(frame.as_bytes());
                bytes += frame.len();
            }
            if only != "frame" {
                vt.feed(scroll.as_bytes());
                bytes += scroll.len();
            }
        }
        let elapsed = started.elapsed();
        let replay = std::time::Instant::now();
        let out = vt.replay();
        eprintln!(
            "fed {} MB in {:?} ({:.0} MB/s); replay {} KB in {:?}",
            bytes / 1_000_000,
            elapsed,
            bytes as f64 / 1e6 / elapsed.as_secs_f64(),
            out.len() / 1000,
            replay.elapsed()
        );
    }
}
