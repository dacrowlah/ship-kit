// The hunt-list format, as a checker. A list is a `# ` title, a header,
// optionally `## METHOD`, and exactly one `## Shapes` section whose shapes
// are `### <ID>. <Name> [generic|repo]` headings, each followed by
// `Mechanism: `, (repo lists only) `Instances:` with labelled bullets,
// `Look for: ` and `Not an instance: ` paragraphs in that order. Ids are
// unique and increasing; a retired id is never reused, so gaps are allowed.

const HEADING = /^### ([A-Z]+)(\d+)\. (.+) \[(generic|repo)\]$/;
const INSTANCE = /^- (Reached main|Caught in review): \S/;

/** @returns {{id: string, number: number, name: string, tag: string, body: string}[]} */
export function parseShapes(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("## Shapes");
  if (start === -1) return [];
  const shapes = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = line.match(HEADING);
    if (match) {
      current = { id: `${match[1]}${match[2]}`, prefix: match[1], number: Number(match[2]), name: match[3], tag: match[4], body: "" };
      shapes.push(current);
    } else if (line.startsWith("### ")) {
      shapes.push({ id: null, prefix: null, number: NaN, name: line, tag: null, body: "" });
      current = null;
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return shapes;
}

/** @param {{prefix: string, shared: boolean}} options @returns {string[]} violations */
export function checkHuntList(text, { prefix, shared }) {
  const violations = [];
  if (!/^# \S/.test(text)) violations.push("list must start with a '# ' title");
  const shapesSections = text.split("\n").filter((l) => l === "## Shapes").length;
  if (shapesSections !== 1) violations.push(`expected exactly one '## Shapes' section, found ${shapesSections}`);
  let last = 0;
  const seen = new Set();
  for (const shape of parseShapes(text)) {
    if (shape.id === null) {
      violations.push(`malformed shape heading: ${shape.name}`);
      continue;
    }
    const where = shape.id;
    if (shape.prefix !== prefix) violations.push(`${where}: id prefix must be ${prefix}`);
    if (seen.has(shape.id)) violations.push(`${where}: duplicate id`);
    seen.add(shape.id);
    if (shape.number <= last) violations.push(`${where}: ids must increase`);
    last = shape.number;
    if (shared && shape.tag !== "generic") violations.push(`${where}: a shared list holds [generic] shapes only`);
    const paragraphs = shape.body.split("\n\n").map((p) => p.trim()).filter(Boolean);
    const order = shared
      ? ["Mechanism: ", "Look for: ", "Not an instance: "]
      : ["Mechanism: ", "Instances:", "Look for: ", "Not an instance: "];
    const found = paragraphs.map((p) => order.find((o) => p.startsWith(o)) ?? null);
    if (JSON.stringify(found) !== JSON.stringify(order)) {
      violations.push(`${where}: paragraphs must be exactly ${order.map((o) => o.trim()).join(", ")} in that order`);
    }
    if (!shared) {
      const instances = paragraphs.find((p) => p.startsWith("Instances:")) ?? "";
      const bullets = instances.split("\n").slice(1);
      if (bullets.length === 0 || !bullets.every((b) => INSTANCE.test(b))) {
        violations.push(`${where}: Instances must be bullets labelled "Reached main:" or "Caught in review:"`);
      }
    }
  }
  return violations;
}
