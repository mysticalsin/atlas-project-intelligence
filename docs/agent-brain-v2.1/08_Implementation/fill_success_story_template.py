"""
Atlas Amaris Success Story DOCX population helper.

Input:
  python fill_success_story_template.py template.docx story.json output.docx --audience internal|client|public

This is a starter adapter, not a guarantee that every template version has identical
table indices. It validates the template structure, replaces known placeholder text,
and removes internal-only notes for client/public outputs. Test against the supplied
template and version-pin the template asset in production.
"""
import argparse, json, os, re
from docx import Document

def replace_in_paragraph(paragraph, replacements):
    # Rebuild paragraph text only when a placeholder occurs. This may normalize run
    # formatting in the affected paragraph; preserve unaffected paragraphs.
    original = paragraph.text
    updated = original
    for old, new in replacements.items():
        if old in updated:
            updated = updated.replace(old, str(new))
    if updated != original:
        paragraph.text = updated

def walk_paragraphs(doc):
    for p in doc.paragraphs:
        yield p
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    yield p
                for nested in cell.tables:
                    for nrow in nested.rows:
                        for ncell in nrow.cells:
                            for p in ncell.paragraphs:
                                yield p

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("template")
    ap.add_argument("story_json")
    ap.add_argument("output")
    ap.add_argument("--audience", choices=["internal","client","public"], default="internal")
    args = ap.parse_args()

    data = json.load(open(args.story_json, encoding="utf-8"))
    doc = Document(args.template)

    project = data.get("project", {})
    summary = data.get("summary", {}).get("text", "")
    challenge = data.get("challenge", {})
    solution = data.get("solution", {})
    differentiator = data.get("amaris_differentiator", {})
    kpis = data.get("kpis", [])

    replacements = {
        "Nombre empresa": project.get("client_display") or "Cliente anonimizado",
        "Banca / Retail / Mining…": project.get("industry") or "",
        "2024": project.get("year") or "",
        "X meses": (str(project.get("duration_months")) + " meses") if project.get("duration_months") else "",
        "Ej: 3": project.get("consultant_count") or "",
        "Ej: Data Engineer": project.get("main_role") or "",
        "Chile": project.get("country") or "",
        "Node, React, AWS, etc.": ", ".join(project.get("technologies", [])),
        "[cliente]": project.get("client_display") or "el cliente",
        "[solución]": solution.get("what_we_did", ""),
        "[resultado principal]": summary,
        "XX%": (str(kpis[0].get("after_value")) + str(kpis[0].get("unit") or "")) if len(kpis)>0 else "",
        "XX hrs": (str(kpis[1].get("after_value")) + str(kpis[1].get("unit") or "")) if len(kpis)>1 else "",
        "X meses": (str(kpis[2].get("after_value")) + str(kpis[2].get("unit") or "")) if len(kpis)>2 else "",
    }
    for p in walk_paragraphs(doc):
        replace_in_paragraph(p, replacements)

    # Add a structured appendix with fields that are not safely addressable as
    # fixed placeholders in every template revision. This remains internal unless
    # audience is client/public and the allowlist below is applied.
    if args.audience == "internal":
        doc.add_page_break()
        doc.add_heading("Anexo Atlas — datos estructurados de la historia", level=1)
        fields = [
            ("Resumen", summary),
            ("Problema del cliente", challenge.get("problem","")),
            ("Por qué era importante", challenge.get("why_important","")),
            ("Qué hicimos", solution.get("what_we_did","")),
            ("Tecnologías", ", ".join(solution.get("technologies", project.get("technologies", [])))),
            ("Modelo de trabajo", solution.get("client_working_model","")),
            ("Nueva capacidad habilitada", data.get("results",{}).get("new_capability","")),
            ("Diferencial Amaris", differentiator.get("why_selected","")),
            ("Qué valoró el cliente", differentiator.get("client_valued","")),
        ]
        for label, value in fields:
            if value:
                doc.add_paragraph(f"{label}: {value}")
        notes = data.get("internal_notes",{})
        if notes:
            doc.add_heading("Notas internas — no compartir con cliente", level=2)
            for key in ("manager","consultant","date"):
                if notes.get(key):
                    doc.add_paragraph(f"{key.capitalize()}: {notes[key]}")

    # Public/client exports must never contain the template's internal notes section.
    # The supplied template has 13 tables: table 11 is the internal-notes heading,
    # table 12 contains manager/consultant/date. Remove both for external audiences.
    if args.audience in ("client","public"):
        if len(doc.tables) >= 13:
            for idx in (12,11):
                tbl = doc.tables[idx]._element
                tbl.getparent().remove(tbl)
        # Also remove any residual internal-note paragraphs if a template revision
        # moves the section outside the tables.
        for p in list(doc.paragraphs):
            if "NOTAS INTERNAS" in p.text.upper() or "NO COMPARTIR CON CLIENTE" in p.text.upper():
                p._element.getparent().remove(p._element)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    doc.save(args.output)
    print(f"Created {args.output} for audience={args.audience}")

if __name__ == "__main__":
    main()
