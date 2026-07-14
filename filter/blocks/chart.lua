-- richmd built-in block kind: chart.
--
-- A `:::chart {type=bar|line|pie}` fenced div (design.md §04/§04.1,
-- ADR-0006) — like cards.lua/stat-grid.lua, NOT a fenced code block like
-- mermaid.lua/vega-lite.lua. Its body is an ordinary markdown table (a
-- Pandoc Table AST node); this file's whole job is expanding that table
-- into a vega-lite spec and then reusing vega-lite.lua's own render
-- function verbatim to produce the identical output shape a hand-authored
-- ```vega-lite block would produce — the same .richmd-diagram/.richmd-vega
-- container, the same CDN/offline runtime, the same theming. This is the
-- only file allowed to know that "chart" exists as a concept, and the only
-- built-in kind whose render function emits another kind's rendering
-- rather than final HTML directly (composition, not a special case —
-- design.md §04.1's own framing).
--
-- TABLE AST SHAPE (confirmed against real Pandoc 3.7 output before writing
-- this file, not assumed — see the chunk report for the probe): a markdown
-- table inside a fenced div's body arrives as block.content[1] being a
-- `Table` node with:
--   table.head.rows[i].cells[j].contents  -- header cell Inlines, row i (only 1 row for a normal table)
--   table.bodies[i].body[j].cells[k].contents -- body cell Inlines, TableBody i, row j, column k
-- Each `.contents` is a list of Inlines (e.g. { Str "Fruit" }), read via
-- pandoc.utils.stringify — exactly the same helper cards.lua's own title
-- extraction uses.

local script_dir = PANDOC_SCRIPT_FILE:match("(.*/)") or "./"
package.path = script_dir .. "../?.lua;" .. package.path
local vega_lite = require("blocks.vega-lite")

local CHART_TYPES = { "bar", "line", "pie" }

local schema = {
  kind = "chart",
  attrs = {
    type = {
      required = true,
      type = "enum",
      enum_values = CHART_TYPES,
    },
    -- x=/y= name header columns explicitly; required only once the table
    -- carries more than two columns, where positional binding (first column
    -- = x/category, second = y/value — ADR-0006) would be ambiguous. Plain
    -- optional strings at the generic schema level: the "required once >2
    -- columns" rule is not expressible as a generic attr schema field, so it
    -- is enforced in this kind's own `validate` hook below, exactly like
    -- cards.lua's badge-tint check is enforced in its own hook rather than
    -- the generic schema.
    x = {
      required = false,
      type = "string",
    },
    y = {
      required = false,
      type = "string",
    },
  },
  body = "required",
  validate = nil, -- set below, after `validate` is defined
}

-- find_table(block) -> pandoc.Table | nil
--
-- A chart block's body is expected to be exactly one markdown table (the
-- schema's generic "body is required" check already covers "no body at
-- all"); this walks the block's own content looking for the first Table
-- node, skipping any stray content around it (e.g. blank Para nodes Pandoc
-- sometimes introduces around a fenced div's blank lines) rather than
-- assuming content[1] is always the table itself.
local function find_table(block)
  for _, blk in ipairs(block.content) do
    if blk.t == "Table" then
      return blk
    end
  end
  return nil
end

-- table_header_names(table_node) -> { name, ... } | {}
--
-- Stringifies each header cell's Inlines in column order. A table with no
-- header row (table_node.head.rows is empty) returns {} — callers treat that
-- as "no header names available", which only matters for x=/y= name-matching;
-- positional binding for a plain 2-column table works regardless.
--
-- NOTE: the parameter is named `table_node`, never `table` — Lua's global
-- `table` library (table.insert/table.concat, used throughout this file)
-- would otherwise be shadowed for the rest of this function's body, causing
-- a silent-until-runtime "attempt to call a nil value (field 'insert')"
-- crash (hit and fixed during this file's own initial red-phase test run).
local function table_header_names(table_node)
  local names = {}
  local header_rows = table_node.head and table_node.head.rows or {}
  if #header_rows == 0 then
    return names
  end
  local header_row = header_rows[1]
  for _, cell in ipairs(header_row.cells) do
    table.insert(names, pandoc.utils.stringify(cell.contents))
  end
  return names
end

-- table_body_rows(table_node) -> { { cell_text, ... }, ... }
--
-- Stringifies every body row's cells, in column order, across ALL
-- TableBody groups (a plain markdown table has exactly one, but this
-- doesn't assume that) — flattened into one list of rows in document order.
local function table_body_rows(table_node)
  local rows = {}
  for _, table_body in ipairs(table_node.bodies) do
    for _, row in ipairs(table_body.body) do
      local cell_texts = {}
      for _, cell in ipairs(row.cells) do
        table.insert(cell_texts, pandoc.utils.stringify(cell.contents))
      end
      table.insert(rows, cell_texts)
    end
  end
  return rows
end

-- column_count(header_names, body_rows) -> integer
--
-- The table's column count, preferring the header row's own cell count (the
-- authoritative source when present) and falling back to the first body
-- row's cell count for a header-less table.
local function column_count(header_names, body_rows)
  if #header_names > 0 then
    return #header_names
  end
  if #body_rows > 0 then
    return #body_rows[1]
  end
  return 0
end

-- find_column_index(header_names, wanted_name) -> index | nil
local function find_column_index(header_names, wanted_name)
  for i, name in ipairs(header_names) do
    if name == wanted_name then
      return i
    end
  end
  return nil
end

-- resolve_binding(attrs, header_names, body_rows, add_error, kind_name, location) -> x_index, y_index | nil, nil
--
-- Implements ADR-0006's positional-binding-by-default rule: a 2-column
-- table binds column 1 -> x, column 2 -> y with no attrs needed; a table
-- with more than 2 columns REQUIRES explicit x=/y= attrs naming header
-- columns, since position alone is ambiguous once there's a third column —
-- never a guess, never a silent truncation to the first two columns (design.md
-- §04.1 failure behavior). Returns nil, nil (having already called
-- add_error) when the binding cannot be resolved.
local function resolve_binding(attrs, header_names, body_rows, add_error, kind_name, location)
  local n_cols = column_count(header_names, body_rows)

  if n_cols > 2 then
    if not attrs.x or attrs.x == "" or not attrs.y or attrs.y == "" then
      add_error(
        kind_name,
        location,
        "table has "
          .. n_cols
          .. " columns; positional x/y binding is ambiguous beyond 2 columns"
          .. " — both 'x=' and 'y=' attrs naming header columns are required (ADR-0006)"
      )
      return nil, nil
    end

    local x_index = find_column_index(header_names, attrs.x)
    if not x_index then
      add_error(
        kind_name,
        location,
        "attr 'x' names column '" .. attrs.x .. "', which does not match any table header column"
      )
      return nil, nil
    end

    local y_index = find_column_index(header_names, attrs.y)
    if not y_index then
      add_error(
        kind_name,
        location,
        "attr 'y' names column '" .. attrs.y .. "', which does not match any table header column"
      )
      return nil, nil
    end

    return x_index, y_index
  end

  -- 2 (or fewer) columns: positional binding by default (ADR-0006), UNLESS
  -- the author explicitly named x=/y= anyway — an explicit binding always
  -- wins over the positional default, never ignored just because it
  -- happened to also be resolvable positionally.
  if (attrs.x and attrs.x ~= "") or (attrs.y and attrs.y ~= "") then
    local x_index = (attrs.x and attrs.x ~= "") and find_column_index(header_names, attrs.x) or 1
    local y_index = (attrs.y and attrs.y ~= "") and find_column_index(header_names, attrs.y) or 2
    if not x_index then
      add_error(
        kind_name,
        location,
        "attr 'x' names column '" .. attrs.x .. "', which does not match any table header column"
      )
      return nil, nil
    end
    if not y_index then
      add_error(
        kind_name,
        location,
        "attr 'y' names column '" .. attrs.y .. "', which does not match any table header column"
      )
      return nil, nil
    end
    return x_index, y_index
  end

  if n_cols < 2 then
    add_error(
      kind_name,
      location,
      "table has " .. n_cols .. " column(s); a chart block needs at least 2 (x and y)"
    )
    return nil, nil
  end

  return 1, 2
end

-- json_string_escape(text) -> string
--
-- Minimal JSON string escaping for values embedded in the generated spec's
-- `data.values` — chart table cell text is untrusted author input (could
-- contain quotes/backslashes/control chars), and this spec's JSON is
-- subsequently re-parsed by vega-lite-check.js and the browser's own
-- JSON.parse, so it must be valid JSON, not just "looks right for the demo
-- case".
local function json_string_escape(text)
  local escaped = text
    :gsub("\\", "\\\\")
    :gsub('"', '\\"')
    :gsub("\n", "\\n")
    :gsub("\r", "\\r")
    :gsub("\t", "\\t")
  return escaped
end

-- json_string(text) -> string
local function json_string(text)
  return '"' .. json_string_escape(text) .. '"'
end

-- cell_is_numeric(text) -> boolean
--
-- A table cell is treated as vega-lite `"quantitative"` when its stringified
-- text parses as a plain Lua number, `"nominal"` otherwise (dates are out of
-- scope — richmd's chart block is the "plain two-column comparison table"
-- convenience case per ADR-0006, not a full charting DSL). Used both for
-- the y/value channel's encoding type and for deciding whether to emit the
-- cell's value as a bare JSON number or a quoted JSON string in `data.values`.
local function cell_is_numeric(text)
  return tonumber(text) ~= nil
end

-- json_value(text) -> string
--
-- Emits a bare JSON number when the cell parses as one, else a JSON string.
local function json_value(text)
  if cell_is_numeric(text) then
    return text
  end
  return json_string(text)
end

-- build_spec(attrs, table_node) -> vega_lite_json_string | nil, error_reason | nil
--
-- The one deterministic derivation both validate() and render() call — the
-- SAME expansion, never re-derived differently between the two phases
-- (design.md §04.1 Interface field: "the expanded spec is what gets
-- rendered — never re-derived twice"). Deterministic from block.content
-- alone (plus attrs), so it is safe to call independently in both phases
-- without threading any state across Pandoc's separate doc:walk calls
-- (richmd-filter.lua's own documented AST-identity caveat).
--
-- Returns the vega-lite spec as a JSON string on success; on failure
-- (unresolvable binding), returns nil plus a human-readable reason instead
-- of calling add_error itself, so render() (which has no add_error
-- callback available) can share this same function — validate() is the
-- only caller that actually reports the error.
local function build_spec(attrs, table_node)
  local header_names = table_header_names(table_node)
  local body_rows = table_body_rows(table_node)

  -- resolve_binding expects an add_error(kind_name, location, reason)
  -- callback; wrap a plain collector here so build_spec has no dependency
  -- on the filter core's real add_error signature, while validate() below
  -- still gets real, block-named errors via its OWN direct call to
  -- resolve_binding (see validate()) — build_spec is also called from
  -- render(), which has no add_error callback available at all.
  local errors = {}
  local x_index, y_index = resolve_binding(attrs, header_names, body_rows, function(_k, _l, reason)
    table.insert(errors, reason)
  end, "chart", "")

  if not x_index then
    return nil, errors[1] or "could not resolve column binding"
  end

  local x_name = header_names[x_index] or ("column" .. x_index)
  local y_name = header_names[y_index] or ("column" .. y_index)

  local values = {}
  for _, row in ipairs(body_rows) do
    local x_cell = row[x_index]
    local y_cell = row[y_index]
    if x_cell ~= nil and y_cell ~= nil then
      table.insert(
        values,
        "{"
          .. json_string(x_name)
          .. ": "
          .. json_string(x_cell)
          .. ", "
          .. json_string(y_name)
          .. ": "
          .. json_value(y_cell)
          .. "}"
      )
    end
  end

  local y_type = "quantitative"
  -- If ANY y-cell fails to parse as numeric, fall back to nominal rather
  -- than emit a spec whose data.values types don't match its own encoding
  -- (a semantic detail vega-lite-check.js's JSON-schema validation does not
  -- itself catch, but wrong is wrong even when validated JSON-schema-shape
  -- fine).
  for _, row in ipairs(body_rows) do
    local y_cell = row[y_index]
    if y_cell ~= nil and not cell_is_numeric(y_cell) then
      y_type = "nominal"
      break
    end
  end

  local mark
  local encoding
  if attrs.type == "pie" then
    mark = '"arc"'
    encoding = "{"
      .. '"theta": {"field": '
      .. json_string(y_name)
      .. ', "type": "'
      .. y_type
      .. '"}, '
      .. '"color": {"field": '
      .. json_string(x_name)
      .. ', "type": "nominal", "sort": null}'
      .. "}"
  else
    mark = json_string(attrs.type) -- "bar" or "line"
    encoding = "{"
      .. '"x": {"field": '
      .. json_string(x_name)
      .. ', "type": "nominal", "sort": null}, '
      .. '"y": {"field": '
      .. json_string(y_name)
      .. ', "type": "'
      .. y_type
      .. '"}'
      .. "}"
  end

  local spec = "{\n"
    .. '  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",\n'
    .. '  "data": {"values": ['
    .. table.concat(values, ", ")
    .. "]},\n"
    .. '  "mark": '
    .. mark
    .. ",\n"
    .. '  "encoding": '
    .. encoding
    .. "\n"
    .. "}"

  return spec, nil
end

-- validate(block, kind_name, location, add_error)
--
-- Called by the filter core's generic validate step alongside the
-- schema-driven attrs/body checks (this kind's `type` enum and required
-- body are already covered generically). This hook parses the table, resolves
-- the column binding (positional or explicit, ADR-0006), and — only once a
-- binding actually resolves — builds the expanded vega-lite spec and runs it
-- through the SAME grammar validator hand-authored vega-lite blocks use
-- (vega-lite.lua's own validate function, called directly here rather than
-- re-shelling-out separately, so there is exactly one place that knows how
-- to invoke vega-lite-check.js).
local function validate(block, kind_name, location, add_error)
  local table_node = find_table(block)
  if not table_node then
    -- Already caught by the generic "body is required" schema check when
    -- there's no body at all; a body that exists but isn't a table is this
    -- kind's own concern.
    add_error(kind_name, location, "chart body must be a markdown table")
    return
  end

  local header_names = table_header_names(table_node)
  local body_rows = table_body_rows(table_node)

  local x_index, y_index = resolve_binding(
    { x = block.attributes.x, y = block.attributes.y },
    header_names,
    body_rows,
    add_error,
    kind_name,
    location
  )
  if not x_index then
    return -- resolve_binding already called add_error with the specific reason
  end

  -- type may already have failed generic enum validation (an unrecognized
  -- type value) — in that case attrs.type is still whatever raw string the
  -- author wrote (validate_attrs resolves it regardless of validity), and
  -- build_spec would emit an invalid `"mark"` value. That's fine: the
  -- generic enum-attr error has already been added by validate_attrs, and
  -- vega-lite-check.js will also reject the resulting spec, giving a second,
  -- consistent error rather than a silent guess — never worse than reporting
  -- nothing.
  local attrs = { type = block.attributes.type, x = block.attributes.x, y = block.attributes.y }
  local spec, build_err = build_spec(attrs, table_node)
  if not spec then
    add_error(kind_name, location, build_err or "could not expand table to a vega-lite spec")
    return
  end

  -- vega-lite.lua does not export a standalone "check this JSON" helper
  -- directly usable without its own (block, kind_name, location, add_error)
  -- signature — call it exactly like the filter core does, with a
  -- synthesized CodeBlock-like object carrying the generated spec as
  -- `.text`, reusing its ENTIRE validate function (which itself shells out
  -- to vega-lite-check.js) rather than duplicating that shell-out here.
  vega_lite.validate({ text = spec }, "chart", location, add_error)
end

schema.validate = validate

-- render(block, resolved_attrs) -> pandoc_ast_node
--
-- Re-derives the SAME spec build_spec produces during validate — this is
-- safe and correct to call again here (rather than threading state across
-- the validate/render phase boundary) because build_spec is a pure,
-- deterministic function of the block's own table content and attrs, and
-- Pandoc AST node identity is not guaranteed to survive across the filter
-- core's separate doc:walk calls anyway (richmd-filter.lua's own documented
-- caveat) — re-deriving fresh in both phases is the same pattern every
-- other kind in this codebase already follows (e.g. render_only_div
-- re-derives kind_name and resolved_attrs fresh rather than reusing
-- anything from validate).
--
-- Once the spec string is in hand, this function calls vega-lite.lua's OWN
-- render function with a synthesized `{text = spec}` object standing in for
-- a CodeBlock (vega-lite.lua's render only ever reads `.text` off its first
-- argument — confirmed by reading its body) — producing the exact same
-- `.richmd-diagram`/`.richmd-vega` output, same CDN/offline runtime, same
-- theming, as a hand-authored ```vega-lite block. Zero duplication of that
-- ~500-line rendering path.
local function render(block, resolved_attrs)
  local table_node = find_table(block)
  local spec = select(1, build_spec(resolved_attrs, table_node))
  -- By the time render() runs, validate() has already guaranteed spec is
  -- non-nil (the fail-closed gate, design.md §00) — a nil spec here would
  -- mean render was reached despite a validation failure, which the filter
  -- core's own control flow makes unreachable.
  return vega_lite.render({ text = spec }, {})
end

-- register(registry) — called once at filter startup to add this kind to
-- the shared registry instance.
local function register(registry)
  registry:register("chart", schema, render)
end

return {
  schema = schema,
  render = render,
  validate = validate,
  register = register,
}
