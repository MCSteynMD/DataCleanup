# Similarity Parser

Windows tool to find near-duplicate product descriptions and review them in a desktop UI.

## Run from source

```powershell
pip install -r requirements.txt
python similarity.py path\to\FOExport.xlsx -o results.xlsx
python review_gui.py
```

## Build manager installer

Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) and PyInstaller:

```powershell
powershell -ExecutionPolicy Bypass -File .\build_package.ps1
```

Outputs:
- `dist\SimilarityParser_Setup.exe` — send this to managers
- `dist\SimilarityParser_for_manager.zip` — portable fallback

## Input format

Works with FOExport-style Excel columns:
- `Product number`
- `Product name`
(optional `Search name` fallback)
