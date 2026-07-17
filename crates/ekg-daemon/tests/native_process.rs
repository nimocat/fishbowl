use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

#[test]
fn native_daemon_publishes_descriptor_and_replays_persisted_operation_after_restart() {
    let root = std::env::temp_dir().join(format!("ekg-native-process-{}", std::process::id()));
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let database = root.join("knowledge.db");
    let token_file = root.join("daemon.token");
    let descriptor = root.join("daemon.json");
    let pid_file = root.join("daemon.pid");
    let static_directory = root.join("web");
    std::fs::create_dir_all(&static_directory).unwrap();
    std::fs::write(
        static_directory.join("index.html"),
        "<html>native trace bench</html>",
    )
    .unwrap();
    std::fs::write(&token_file, "process-token").unwrap();

    let mut first = spawn(
        &database,
        &token_file,
        &descriptor,
        &pid_file,
        &static_directory,
    );
    let first_descriptor = wait_descriptor(&descriptor);
    let first_port = first_descriptor["port"].as_u64().unwrap() as u16;
    let first_instance = first_descriptor["instanceId"].as_str().unwrap().to_owned();
    let registered = rpc(
        first_port,
        "process-token",
        json!({
            "protocolVersion": 2,
            "requestId": "register-before-crash",
            "operation": "registerProject",
            "input": {
                "name": "Restart Project",
                "root": project,
                "operationId": "persistent-register-operation"
            }
        }),
    );
    assert_eq!(registered["ok"], true);
    let project_id = registered["result"]["id"].as_str().unwrap();
    let problem = rpc(
        first_port,
        "process-token",
        json!({
            "protocolVersion": 2,
            "requestId": "problem-before-crash",
            "operation": "recordProblem",
            "input": {
                "project": {"projectId": project_id},
                "operationId": "browser-problem-operation",
                "caseTitle": "Native browser Case",
                "data": {"summary": "Visible through Rust HTTP", "domain": "browser"}
            }
        }),
    );
    assert_eq!(problem["ok"], true);
    let graph: Value = serde_json::from_str(&get(
        first_port,
        &format!("/api/v1/graph?project_id={project_id}"),
    ))
    .unwrap();
    assert_eq!(graph["cases"][0]["title"], "Native browser Case");
    assert!(get(first_port, "/").contains("native trace bench"));
    first.kill().unwrap();
    first.wait().unwrap();

    let mut second = spawn(
        &database,
        &token_file,
        &descriptor,
        &pid_file,
        &static_directory,
    );
    let second_descriptor = wait_descriptor_with_new_instance(&descriptor, &first_instance);
    let second_port = second_descriptor["port"].as_u64().unwrap() as u16;
    let replay = rpc(
        second_port,
        "process-token",
        json!({
            "protocolVersion": 2,
            "requestId": "register-after-crash",
            "operation": "registerProject",
            "input": {
                "name": "Restart Project",
                "root": project,
                "operationId": "persistent-register-operation"
            }
        }),
    );
    assert_eq!(replay["result"], registered["result"]);
    let projects = rpc(
        second_port,
        "process-token",
        json!({
            "protocolVersion": 2,
            "requestId": "list-after-crash",
            "operation": "listProjects",
            "input": {}
        }),
    );
    assert_eq!(projects["result"].as_array().unwrap().len(), 1);
    second.kill().unwrap();
    second.wait().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

fn spawn(
    database: &std::path::Path,
    token: &std::path::Path,
    descriptor: &std::path::Path,
    pid: &std::path::Path,
    static_directory: &std::path::Path,
) -> Child {
    Command::new(env!("CARGO_BIN_EXE_ekg-rust-core"))
        .args([
            "daemon",
            "--database",
            database.to_str().unwrap(),
            "--token-file",
            token.to_str().unwrap(),
            "--descriptor",
            descriptor.to_str().unwrap(),
            "--pid-file",
            pid.to_str().unwrap(),
            "--port",
            "0",
            "--static-directory",
            static_directory.to_str().unwrap(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response.split_once("\r\n\r\n").unwrap().1.to_owned()
}

fn wait_descriptor(path: &std::path::Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(value) = serde_json::from_slice(&bytes) {
                return value;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("native daemon descriptor was not published")
}

fn wait_descriptor_with_new_instance(path: &std::path::Path, previous: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let value = wait_descriptor(path);
        if value["instanceId"].as_str() != Some(previous) {
            return value;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("restarted daemon did not replace its descriptor")
}

fn rpc(port: u16, token: &str, body: Value) -> Value {
    let encoded = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .write_all(
            format!(
                "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{encoded}",
                encoded.len()
            )
            .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let body = response.split_once("\r\n\r\n").unwrap().1;
    serde_json::from_str(body).unwrap()
}
