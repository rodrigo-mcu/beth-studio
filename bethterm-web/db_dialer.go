package main

// db_dialer.go — hook for reaching a database through something other than a
// direct TCP connection (for example an SSH tunnel).
//
// Nothing here depends on an SSH implementation. A future module only has to
// set dbTunnelProvider (for instance in an init function of its own file):
//
//	func init() {
//		dbTunnelProvider = func(ctx context.Context, c DBConnConfig) (DBDialer, error) {
//			host, err := sshHostByID(c.Tunnel) // that module's own lookup
//			...
//			return tunnel, nil // tunnel.DialContext opens a "direct-tcpip" channel
//		}
//	}
//
// The returned dialer is used for every new connection of that pool:
// PostgreSQL (pgx ConnConfig.DialFunc), MySQL (a registered dial network) and
// SQL Server (Connector.Dialer). SQLite is a local file and never dials.

import (
	"context"
	"errors"
	"net"
)

// DBDialer opens the byte stream to the database server. The address is the
// host:port saved in the connection, as seen from the far end of the tunnel.
type DBDialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

// dbTunnelProvider returns the dialer for a connection whose Tunnel field is
// set. nil means "no tunnel support built in yet".
var dbTunnelProvider func(ctx context.Context, c DBConnConfig) (DBDialer, error)

// dbDialerFor returns nil for a direct connection.
func dbDialerFor(ctx context.Context, c DBConnConfig) (DBDialer, error) {
	if c.Tunnel == "" || c.Driver == dbSQLite {
		return nil, nil
	}
	if dbTunnelProvider == nil {
		return nil, errors.New("esta conexão usa túnel SSH, mas o túnel ainda não está disponível nesta versão")
	}
	return dbTunnelProvider(ctx, c)
}
