import json

from runtime_env import configure_runtime_env

runtime_paths = configure_runtime_env()

from marker.models import create_model_dict
from marker.util import download_font


def main() -> int:
    create_model_dict()
    download_font()
    print(
        json.dumps(
            {
                "ok": True,
                "modelsDir": str(runtime_paths["models_dir"]),
                "fontPath": str(runtime_paths["font_path"]),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
