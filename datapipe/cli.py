import argparse
from .pipeline import Pipeline
from .transforms import filter_rows, rename_columns, add_computed_column
from .utils import load_config, read_data, write_data


TRANSFORM_MAP = {
    'filter_rows': filter_rows,
    'rename_columns': rename_columns,
    'add_computed_column': add_computed_column
}


def build_pipeline(config):
    """Build pipeline from configuration."""
    pipeline = Pipeline()
    
    for step in config['pipeline']:
        transform_type = step['type']
        params = step.get('params', {})
        
        if transform_type not in TRANSFORM_MAP:
            raise ValueError(f"Unknown transform type: {transform_type}")
        
        transform_func = TRANSFORM_MAP[transform_type]
        
        def step_func(data, transform_func=transform_func, params=params):
            return transform_func(data, **params)
        
        pipeline.add_step(step_func)
    
    return pipeline


def main():
    parser = argparse.ArgumentParser(description='Data processing pipeline CLI tool.')
    parser.add_argument('--input', required=True, help='Path to input CSV file')
    parser.add_argument('--output', required=True, help='Path to output CSV file')
    parser.add_argument('--config', required=True, help='Path to YAML configuration file')
    
    args = parser.parse_args()
    
    # Load configuration
    config = load_config(args.config)
    
    # Build pipeline
    pipeline = build_pipeline(config)
    
    # Read input data
    data = read_data(args.input)
    
    # Execute pipeline
    processed_data = pipeline.execute(data)
    
    # Write output
    write_data(processed_data, args.output)
    
    print(f"Processing completed successfully! Output saved to: {args.output}")


if __name__ == '__main__':
    main()
