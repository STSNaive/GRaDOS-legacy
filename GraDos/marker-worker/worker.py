import base64
import json
import re
import sys
import tempfile
from pathlib import Path

from runtime_env import configure_runtime_env

configure_runtime_env()

from marker.config.parser import ConfigParser
from marker.models import create_model_dict
from marker.output import text_from_rendered


def compact_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n").strip()
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw:
            raise ValueError("Empty JSON input.")

        request = json.loads(raw)
        file_name = Path(request.get("fileName") or "document.pdf").name
        if not file_name.lower().endswith(".pdf"):
            file_name = f"{file_name}.pdf"

        pdf_bytes = base64.b64decode(request["pdfBase64"])

        cli_options = {
            "output_format": "markdown",
            "output_dir": tempfile.gettempdir(),
            "disable_multiprocessing": True,
            "disable_image_extraction": True,
        }
        config_parser = ConfigParser(cli_options)
        converter_cls = config_parser.get_converter_cls()
        converter = converter_cls(
            config=config_parser.generate_config_dict(),
            artifact_dict=create_model_dict(),
            processor_list=config_parser.get_processors(),
            renderer=config_parser.get_renderer(),
            llm_service=config_parser.get_llm_service(),
        )

        with tempfile.TemporaryDirectory(prefix="grados-marker-") as temp_dir:
            pdf_path = Path(temp_dir) / file_name
            pdf_path.write_bytes(pdf_bytes)
            rendered = converter(str(pdf_path))

        markdown, _, _ = text_from_rendered(rendered)
        response = {
            "ok": True,
            "markdown": compact_markdown(markdown),
        }
    except Exception as exc:
        response = {
            "ok": False,
            "error": str(exc),
        }

    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
