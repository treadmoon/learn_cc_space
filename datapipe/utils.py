import yaml
import pandas as pd


def load_config(config_path):
    """Load pipeline configuration from YAML file."""
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)


def read_data(input_path):
    """Read input data from CSV."""
    return pd.read_csv(input_path)


def write_data(df, output_path):
    """Write processed data to CSV."""
    df.to_csv(output_path, index=False)
