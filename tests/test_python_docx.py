def test_python_docx_imports():
    import docx
    assert callable(docx.Document)
