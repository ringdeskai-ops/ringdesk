module.exports = {
  // Tells Jest to use the Node environment (not a browser)
  testEnvironment: 'node',
  
  // Clear mock calls and instances between every test
  clearMocks: true,
  
  // Ignore the node_modules folder
  testPathIgnorePatterns: ["/node_modules/"],
  
  // Show individual test results as they run
  verbose: true
};