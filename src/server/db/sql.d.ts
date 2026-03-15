// Allows TypeScript to accept `import x from '*.sql'`
// esbuild handles the actual transformation (loader: { '.sql': 'text' })
// tsx handles it via its built-in text file support
declare module '*.sql' {
  const content: string;
  export default content;
}
