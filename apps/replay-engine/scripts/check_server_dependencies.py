"""Fail the API image build if a model runtime enters its installed dependencies."""
from importlib import metadata


def check_server_dependencies() -> None:
    forbidden = {"sklearn", "scikit-learn", "torch", "transformers"}
    installed = {dist.metadata["Name"].lower().replace("_", "-") for dist in metadata.distributions()}
    found = sorted(installed & forbidden)
    if found:
        raise SystemExit("Forbidden API image dependencies: " + ", ".join(found))


if __name__ == "__main__":
    check_server_dependencies()
