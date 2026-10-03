/**
 * PostgreSQL e SQL Server sempre listam os bancos que o usuário pode acessar;
 * o banco inicial da conexão só vem destacado e é o fallback se a listagem falhar.
 */
export function showsAllDatabases(hasDatabaseLevel: boolean): boolean {
  return hasDatabaseLevel;
}
