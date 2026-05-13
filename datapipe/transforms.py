import pandas as pd


def filter_rows(df, condition):
    """Filter DataFrame rows based on a boolean condition."""
    return df.query(condition)


def rename_columns(df, column_mapping):
    """Rename DataFrame columns based on the provided mapping."""
    return df.rename(columns=column_mapping)


def add_computed_column(df, new_column_name, expression):
    """Add a new computed column based on an expression using existing columns."""
    df[new_column_name] = df.eval(expression)
    return df
