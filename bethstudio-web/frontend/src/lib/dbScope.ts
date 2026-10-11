/**
 * PostgreSQL e SQL Server listam os bancos que o usuário pode acessar, exceto
 * quando a conexão tem "Banco inicial": aí abre só esse banco.
 */
export function showsAllDatabases(hasDatabaseLevel: boolean, pinnedDatabase?: string): boolean {
  return hasDatabaseLevel && !pinnedDatabase?.trim();
}
