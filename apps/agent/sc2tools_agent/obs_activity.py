"""Check native and plugin OBS outputs without sharing the scene-switch socket."""
def outputs_active(reader):
    if reader is None or reader.disabled:
        return False
    with reader.lock:
        try:
            connection=reader._connection()
            if connection.get_stream_status().output_active or connection.get_record_status().output_active:
                return True
            rows=connection.get_output_list().outputs
            if not isinstance(rows,list):
                return True  # An unknown output state must not interrupt a stream.
            for row in rows:
                name=row.get("outputName") if isinstance(row,dict) else None
                if not name or connection.get_output_status(name).output_active is not False:
                    return True
            return False
        except (ConnectionRefusedError,FileNotFoundError):
            reader.close()
            return False
        except Exception:
            reader.close()
            return True
