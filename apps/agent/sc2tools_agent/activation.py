"""Local, per-state-directory activation. QtNetwork is loaded only for GUI mode."""
import json
from pathlib import Path
from .instance_lock import _mutex_name


def server_name(state_dir):
    return _mutex_name(Path(state_dir).resolve()).replace("\\", "-")


def activate_existing(state_dir, *, timeout_ms=1500):
    try:
        from PySide6 import QtCore, QtNetwork
        app = QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
        socket = QtNetwork.QLocalSocket()
        socket.connectToServer(server_name(state_dir))
        if not socket.waitForConnected(timeout_ms):
            return False
        socket.write(b'{"cmd":"show"}\n')
        if socket.bytesToWrite():
            socket.waitForBytesWritten(timeout_ms)
        if not socket.bytesAvailable():
            socket.waitForReadyRead(timeout_ms)
        data=bytes(socket.readAll())
        socket.disconnectFromServer()
        return json.loads(data) == {"ok":True} if data else False
    except (ImportError, RuntimeError, OSError, ValueError):
        return False


def listen(state_dir, on_show, *, parent=None):
    from PySide6 import QtNetwork
    name = server_name(state_dir)
    QtNetwork.QLocalServer.removeServer(name)
    server = QtNetwork.QLocalServer(parent)
    # OS permissions keep this activation-only channel local to the user.
    server.setSocketOptions(QtNetwork.QLocalServer.UserAccessOption)
    if not server.listen(name):
        raise OSError(server.errorString())
    clients = set()
    def accept():
        while server.hasPendingConnections():
            socket = server.nextPendingConnection()
            clients.add(socket)
            buffer = bytearray()
            def read(socket=socket, buffer=buffer):
                buffer.extend(bytes(socket.readAll()))
                if len(buffer) > 256:
                    socket.disconnectFromServer()
                    return
                if b"\n" not in buffer:
                    return
                try:
                    message = json.loads(bytes(buffer).split(b"\n", 1)[0])
                except (ValueError, UnicodeError):
                    message = None
                if message == {"cmd": "show"}:
                    on_show()
                    socket.write(b'{"ok":true}')
                    socket.flush()
                socket.disconnectFromServer()
            socket.readyRead.connect(read)
            socket.disconnected.connect(lambda socket=socket: (clients.discard(socket), socket.deleteLater()))
            read()
    server.newConnection.connect(accept)
    server._clients = clients
    return server
