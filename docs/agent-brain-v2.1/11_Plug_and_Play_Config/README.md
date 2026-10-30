# Plug-and-play configuration

- `atlas_workflow.yaml`: canonical workflow sequence, branches, triggers and global rules.
- `success_story_template.schema.json`: structured success-story payload schema.
- `field_visibility_policy.yaml`: public versus internal field allowlist.
- `sample_story_TEST_ONLY.json`: synthetic test fixture only; never use as real customer evidence.
- `../08_Implementation/fill_success_story_template.py`: starter DOCX template population helper.

## Test
```bash
python ../08_Implementation/fill_success_story_template.py ../10_Source_References/Entrevista_Caso_de_Exito_Consultores_Template.docx sample_story_TEST_ONLY.json /tmp/atlas-public-test.docx --audience public
python ../08_Implementation/fill_success_story_template.py ../10_Source_References/Entrevista_Caso_de_Exito_Consultores_Template.docx sample_story_TEST_ONLY.json /tmp/atlas-internal-test.docx --audience internal
```

The supplied DOCX is a versioned template dependency. Confirm table structure and styles before production rollout. The starter helper handles the current 13-table source template and must be adapted when the template changes.
