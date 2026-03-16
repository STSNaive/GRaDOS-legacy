import os
from pathlib import Path


def configure_runtime_env() -> dict[str, Path]:
    root = Path(__file__).resolve().parent
    cache_root = root / ".cache"
    models_dir = cache_root / "models"
    hf_home = cache_root / "hf"
    torch_home = cache_root / "torch"
    fonts_dir = cache_root / "fonts"
    font_name = "GoNotoCurrent-Regular.ttf"
    font_path = fonts_dir / font_name

    for directory in (cache_root, models_dir, hf_home, torch_home, fonts_dir):
        directory.mkdir(parents=True, exist_ok=True)

    # Load local.env written by install-marker.ps1 (contains TORCH_DEVICE, etc.)
    local_env = root / "local.env"
    if local_env.is_file():
        for line in local_env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

    os.environ.setdefault("GRPC_VERBOSITY", "ERROR")
    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("LOGLEVEL", "ERROR")
    os.environ.setdefault("MODEL_CACHE_DIR", str(models_dir))
    os.environ.setdefault("HF_HOME", str(hf_home))
    os.environ.setdefault("HF_HUB_CACHE", str(hf_home / "hub"))
    os.environ.setdefault("TORCH_HOME", str(torch_home))
    os.environ.setdefault("XDG_CACHE_HOME", str(cache_root))
    os.environ.setdefault("FONT_DIR", str(fonts_dir))
    os.environ.setdefault("FONT_PATH", str(font_path))

    return {
        "root": root,
        "cache_root": cache_root,
        "models_dir": models_dir,
        "hf_home": hf_home,
        "torch_home": torch_home,
        "fonts_dir": fonts_dir,
        "font_path": font_path,
    }
