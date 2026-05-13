import pytest
import pandas as pd
from datapipe.pipeline import Pipeline
from datapipe.transforms import filter_rows, rename_columns, add_computed_column


def test_pipeline_chaining():
    """Test that pipeline can be built with chained add_step calls."""
    pipeline = Pipeline()
    result = pipeline.add_step(lambda x: x + 1).add_step(lambda x: x * 2)
    
    assert isinstance(result, Pipeline)
    assert len(pipeline.steps) == 2


def test_pipeline_execution():
    """Test simple pipeline execution."""
    def add_one(x):
        return x + 1
    
    def multiply_by_two(x):
        return x * 2
    
    pipeline = Pipeline()
    pipeline.add_step(add_one).add_step(multiply_by_two)
    
    result = pipeline.execute(3)
    assert result == (3 + 1) * 2  # Should be 8


def test_pipeline_with_transforms():
    """Test pipeline with actual DataFrame transforms."""
    data = pd.DataFrame({
        'age': [10, 20, 30],
        'first_name': ['Alice', 'Bob', 'Charlie'],
        'last_name': ['Smith', 'Johnson', 'Brown']
    })
    
    pipeline = Pipeline()
    pipeline.add_step(lambda df: filter_rows(df, 'age > 18'))\
            .add_step(lambda df: rename_columns(df, {'first_name': 'fname', 'last_name': 'lname'}))\
            .add_step(lambda df: add_computed_column(df, 'full_name', 'fname + " " + lname'))
    
    result = pipeline.execute(data)
    assert len(result) == 2
    assert 'fname' in result.columns
    assert 'first_name' not in result.columns
    assert 'full_name' in result.columns
    assert result.iloc[0]['full_name'] == 'Bob Johnson'


def test_pipeline_error_handling():
    """Test that pipeline properly raises errors with helpful messages."""
    def error_step(df):
        raise ValueError("Test error")
    
    pipeline = Pipeline()
    pipeline.add_step(error_step)
    
    with pytest.raises(RuntimeError) as excinfo:
        pipeline.execute(pd.DataFrame())
    
    assert "Error executing pipeline step" in str(excinfo.value)
    assert "Test error" in str(excinfo.value)
