class Pipeline:
    def __init__(self):
        self.steps = []
    
    def add_step(self, step_func):
        """Add a processing step to the pipeline. Can be a function or any callable."""
        self.steps.append(step_func)
        return self  # Enable chaining
    
    def execute(self, data):
        """Execute all pipeline steps in order on the input data."""
        result = data
        for step in self.steps:
            try:
                result = step(result)
            except Exception as e:
                raise RuntimeError(f"Error executing pipeline step: {str(e)}") from e
        return result
